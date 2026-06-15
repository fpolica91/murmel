package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/awebai/aw/awconfig"
	"github.com/spf13/cobra"
)

// `aw login` performs a browser/device OAuth flow (RFC 8628 Device
// Authorization Grant) against the Better Auth issuer, obtains a JWT plus a
// refresh token, and caches them at ~/.aw/token via awconfig.SaveToken.
//
// The device flow is the right shape for a CLI: it does not need a local
// callback HTTP server or a registered redirect URI per machine. The CLI
// asks the issuer for a device_code + user_code, prints (and tries to open)
// a verification URL for the human to approve in a browser, then polls the
// token endpoint until approval completes.
//
// This command is additive and does not touch the team-certificate auth
// path. It only writes the bearer-token cache that awconfig.AttachBearer
// reads. Wiring the bearer header into the shared HTTP client and registering
// this command on rootCmd are integration steps recorded in the task
// follow_ups (this lane must not edit client.go or command registration).

var (
	loginIssuerURL    string
	loginClientID     string
	loginScope        string
	loginNoBrowser    bool
	loginTimeout      time.Duration
	loginPollOverride time.Duration
)

// LoginIssuerEnvVar is the environment override for the Better Auth issuer
// base URL (the host that exposes the device-authorization and token
// endpoints).
const LoginIssuerEnvVar = "AWEB_AUTH_ISSUER"

// LoginClientIDEnvVar is the environment override for the OAuth client_id the
// CLI presents to the issuer.
const LoginClientIDEnvVar = "AWEB_AUTH_CLIENT_ID"

// defaultLoginClientID is the public client identifier for the `aw` CLI. A
// device-flow public client has no secret; the issuer recognizes this id.
const defaultLoginClientID = "aweb-cli"

// defaultLoginScope requests an offline-access scope so the issuer returns a
// refresh token alongside the access token.
const defaultLoginScope = "openid profile offline_access"

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Sign in via your browser and cache an aweb access token",
	Long: `Sign in to aweb using a browser-based device authorization flow.

aw login asks the auth server for a one-time code, opens (or prints) a
verification URL, and waits for you to approve the sign-in in your browser.
On success it caches the issued access token and its refresh token at
~/.aw/token. Subsequent commands reuse and auto-refresh that token.

This is additive to team-certificate auth: a workspace bound to a team
certificate keeps working without aw login.`,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		loadDotenvBestEffort()
		maybeCheckLatestVersion(cmd)
	},
	RunE: runLogin,
}

func init() {
	loginCmd.Flags().StringVar(&loginIssuerURL, "issuer", "", "Auth issuer base URL (overrides AWEB_AUTH_ISSUER)")
	loginCmd.Flags().StringVar(&loginClientID, "client-id", "", "OAuth client id (overrides AWEB_AUTH_CLIENT_ID)")
	loginCmd.Flags().StringVar(&loginScope, "scope", defaultLoginScope, "OAuth scopes to request")
	loginCmd.Flags().BoolVar(&loginNoBrowser, "no-browser", false, "Do not attempt to open a browser; only print the verification URL")
	loginCmd.Flags().DurationVar(&loginTimeout, "timeout", 5*time.Minute, "How long to wait for browser approval")
	loginCmd.Flags().DurationVar(&loginPollOverride, "poll-interval", 0, "Override the token-endpoint poll interval (default: server-provided)")

	rootCmd.AddCommand(loginCmd)
}

// deviceAuthResponse is the RFC 8628 device-authorization response.
type deviceAuthResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int64  `json:"expires_in"`
	Interval                int64  `json:"interval"`
}

// deviceTokenResponse is the token-endpoint response for the device-code
// grant. The "error" field carries the RFC 8628 poll signals
// (authorization_pending, slow_down) and terminal errors (access_denied,
// expired_token).
type deviceTokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int64  `json:"expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func runLogin(cmd *cobra.Command, args []string) error {
	issuer, err := resolveLoginIssuer()
	if err != nil {
		return err
	}
	clientID := resolveLoginClientID()

	ctx, cancel := context.WithTimeout(cmd.Context(), loginTimeout+30*time.Second)
	defer cancel()

	device, err := requestDeviceCode(ctx, issuer, clientID, loginScope)
	if err != nil {
		return err
	}

	verifyURL := strings.TrimSpace(device.VerificationURIComplete)
	if verifyURL == "" {
		verifyURL = strings.TrimSpace(device.VerificationURI)
	}

	if !jsonFlag {
		printLoginInstructions(cmd.OutOrStdout(), device, verifyURL)
	}
	if !loginNoBrowser && verifyURL != "" {
		if err := openBrowser(verifyURL); err != nil && !jsonFlag {
			fmt.Fprintf(cmd.ErrOrStderr(), "Could not open a browser automatically (%v); open the URL above manually.\n", err)
		}
	}

	tok, err := pollForToken(ctx, issuer, clientID, device)
	if err != nil {
		return err
	}

	if err := awconfig.SaveToken(tok); err != nil {
		return fmt.Errorf("login succeeded but caching the token failed: %w", err)
	}

	result := loginResult{
		Status:    "ok",
		Subject:   tok.Subject,
		ExpiresAt: tok.ExpiresAt,
		TokenPath: tokenPathForDisplay(),
	}
	printOutput(result, formatLogin)
	return nil
}

type loginResult struct {
	Status    string    `json:"status"`
	Subject   string    `json:"subject,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
	TokenPath string    `json:"token_path,omitempty"`
}

func formatLogin(v any) string {
	r, ok := v.(loginResult)
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("Logged in.\n")
	if strings.TrimSpace(r.Subject) != "" {
		fmt.Fprintf(&b, "  subject: %s\n", r.Subject)
	}
	if !r.ExpiresAt.IsZero() {
		fmt.Fprintf(&b, "  token expires: %s\n", r.ExpiresAt.Local().Format(time.RFC3339))
	}
	if strings.TrimSpace(r.TokenPath) != "" {
		fmt.Fprintf(&b, "  token cached at: %s\n", r.TokenPath)
	}
	return b.String()
}

func printLoginInstructions(out io.Writer, device *deviceAuthResponse, verifyURL string) {
	fmt.Fprintln(out, "To sign in, open this URL in your browser:")
	fmt.Fprintf(out, "  %s\n", verifyURL)
	if strings.TrimSpace(device.UserCode) != "" && strings.TrimSpace(device.VerificationURIComplete) == "" {
		fmt.Fprintf(out, "and enter the code: %s\n", device.UserCode)
	}
	fmt.Fprintln(out, "Waiting for approval...")
}

func tokenPathForDisplay() string {
	path, err := awconfig.DefaultTokenPath()
	if err != nil {
		return ""
	}
	return path
}

// resolveLoginIssuer resolves the issuer base URL from --issuer, then
// AWEB_AUTH_ISSUER. There is no hardcoded default issuer: the auth server URL
// is deployment-specific, so a missing value is a usage error with a clear
// hint rather than a silent fallback to the wrong host.
func resolveLoginIssuer() (string, error) {
	value := strings.TrimSpace(loginIssuerURL)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(LoginIssuerEnvVar))
	}
	if value == "" {
		return "", usageError("auth issuer is required: pass --issuer or set %s", LoginIssuerEnvVar)
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", usageError("invalid auth issuer URL %q", value)
	}
	return strings.TrimRight(value, "/"), nil
}

func resolveLoginClientID() string {
	value := strings.TrimSpace(loginClientID)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(LoginClientIDEnvVar))
	}
	if value == "" {
		value = defaultLoginClientID
	}
	return value
}

func requestDeviceCode(ctx context.Context, issuer, clientID, scope string) (*deviceAuthResponse, error) {
	form := url.Values{}
	form.Set("client_id", clientID)
	if strings.TrimSpace(scope) != "" {
		form.Set("scope", scope)
	}
	endpoint := issuer + "/device/code"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("device authorization: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := loginHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("device authorization: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("device authorization failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	var out deviceAuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("device authorization: decode response: %w", err)
	}
	if strings.TrimSpace(out.DeviceCode) == "" {
		return nil, fmt.Errorf("device authorization: server returned no device_code")
	}
	return &out, nil
}

func pollForToken(ctx context.Context, issuer, clientID string, device *deviceAuthResponse) (*awconfig.CachedToken, error) {
	interval := time.Duration(device.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	if loginPollOverride > 0 {
		interval = loginPollOverride
	}

	tokenURL := issuer + "/token"
	deadline := time.Now().Add(loginTimeout)
	if device.ExpiresIn > 0 {
		issuerDeadline := time.Now().Add(time.Duration(device.ExpiresIn) * time.Second)
		if issuerDeadline.Before(deadline) {
			deadline = issuerDeadline
		}
	}

	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("login timed out waiting for browser approval")
		}

		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}

		body, err := requestDeviceToken(ctx, tokenURL, clientID, device.DeviceCode)
		if err != nil {
			return nil, err
		}
		switch strings.TrimSpace(body.Error) {
		case "":
			if strings.TrimSpace(body.AccessToken) == "" {
				return nil, fmt.Errorf("login: token endpoint returned no access_token")
			}
			return cachedTokenFromDeviceResponse(tokenURL, body), nil
		case "authorization_pending":
			// keep polling at the current interval
		case "slow_down":
			// RFC 8628: increase the interval by 5 seconds on slow_down.
			interval += 5 * time.Second
		case "access_denied":
			return nil, fmt.Errorf("login denied in the browser")
		case "expired_token":
			return nil, fmt.Errorf("login code expired before approval; run aw login again")
		default:
			desc := strings.TrimSpace(body.ErrorDescription)
			if desc == "" {
				desc = body.Error
			}
			return nil, fmt.Errorf("login failed: %s", desc)
		}
	}
}

func requestDeviceToken(ctx context.Context, tokenURL, clientID, deviceCode string) (*deviceTokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	form.Set("device_code", deviceCode)
	form.Set("client_id", clientID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("token poll: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := loginHTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("token poll: %w", err)
	}
	defer resp.Body.Close()

	// RFC 8628 returns 400 with an "error" body for pending/slow_down, so a
	// non-2xx status is not necessarily fatal: decode the body and let the
	// caller branch on the error code. Only treat an undecodable non-2xx as
	// a hard failure.
	var out deviceTokenResponse
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&out); err != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("token poll failed (%d)", resp.StatusCode)
		}
		return nil, fmt.Errorf("token poll: decode response: %w", err)
	}
	return &out, nil
}

func cachedTokenFromDeviceResponse(tokenURL string, body *deviceTokenResponse) *awconfig.CachedToken {
	tok := &awconfig.CachedToken{
		AccessToken:  body.AccessToken,
		RefreshToken: body.RefreshToken,
		TokenType:    body.TokenType,
		TokenURL:     tokenURL,
	}
	if body.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(body.ExpiresIn) * time.Second)
	}
	// Backfill subject from the JWT itself for display. LoadToken backfills
	// expiry on read; doing subject here keeps the freshly written cache
	// complete. This is display-only: the server remains the identity
	// authority.
	if sub, ok := awconfig.JWTSubjectUnverified(body.AccessToken); ok {
		tok.Subject = sub
	}
	return tok
}

func loginHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// openBrowser opens url in the user's default browser. It is best-effort:
// callers fall back to printing the URL when this returns an error.
func openBrowser(target string) error {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
		args = []string{target}
	case "windows":
		cmd = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", target}
	default:
		cmd = "xdg-open"
		args = []string{target}
	}
	return exec.Command(cmd, args...).Start()
}
