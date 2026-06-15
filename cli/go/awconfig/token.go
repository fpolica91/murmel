package awconfig

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SimpleAuth token cache.
//
// Story1.2 caches the Better Auth issued JWT (plus its refresh token) at
// ~/.aw/token so that subsequent `aw` commands can attach a
// `Authorization: Bearer <token>` header. The cache is a 0600 JSON file
// written atomically (temp-file-and-rename) so a crash mid-write never
// leaves a truncated secret on disk.
//
// This file is intentionally additive and self-contained: it does not touch
// the team-certificate auth path. A request authorizes via the certificate
// path OR the bearer-token path; callers decide which based on whether a
// cached token exists.

// TokenFileName is the on-disk name of the cached token under the aw token
// directory (~/.aw).
const TokenFileName = "token"

// tokenRefreshSkew is how long before the actual JWT expiry we treat the
// token as needing refresh. A non-zero skew avoids races where a token that
// looks valid locally is rejected server-side by the time the request lands.
const tokenRefreshSkew = 60 * time.Second

// DefaultAWTokenDir returns ~/.aw, the directory that holds the cached
// SimpleAuth token. This is deliberately distinct from DefaultUserStateDir
// (~/.config/aw): the Story1.2 contract pins the token cache at ~/.aw/token.
func DefaultAWTokenDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".aw"), nil
}

// DefaultTokenPath returns ~/.aw/token.
func DefaultTokenPath() (string, error) {
	dir, err := DefaultAWTokenDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, TokenFileName), nil
}

// CachedToken is the on-disk representation of a cached SimpleAuth session.
//
// AccessToken is the Better Auth issued JWT (RS256/ES256). RefreshToken is
// the opaque refresh token used to mint a new access token when the access
// token expires. ExpiresAt is the access-token expiry; it is populated from
// the token-endpoint response when available and otherwise derived from the
// JWT `exp` claim. TokenURL records the token endpoint so refresh works even
// if the caller does not re-supply it.
type CachedToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	TokenURL     string    `json:"token_url,omitempty"`
	Subject      string    `json:"subject,omitempty"`
}

// tokenMu serializes concurrent load/save within a single process so two
// goroutines refreshing at once do not clobber each other's write. The
// atomic rename guards cross-process safety; this guards in-process.
var tokenMu sync.Mutex

// SaveToken writes tok to ~/.aw/token atomically with 0600 permissions.
func SaveToken(tok *CachedToken) error {
	if tok == nil {
		return fmt.Errorf("save token: nil token")
	}
	path, err := DefaultTokenPath()
	if err != nil {
		return err
	}
	return SaveTokenAt(path, tok)
}

// SaveTokenAt writes tok to path atomically with 0600 permissions. Exposed
// for tests and for callers that need a non-default location.
func SaveTokenAt(path string, tok *CachedToken) error {
	if tok == nil {
		return fmt.Errorf("save token: nil token")
	}
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return fmt.Errorf("save token: marshal: %w", err)
	}
	tokenMu.Lock()
	defer tokenMu.Unlock()
	return atomicWriteFile(path, data)
}

// LoadToken reads and parses ~/.aw/token. It returns an error wrapping
// os.ErrNotExist when no token is cached, so callers can branch with
// errors.Is(err, os.ErrNotExist).
func LoadToken() (*CachedToken, error) {
	path, err := DefaultTokenPath()
	if err != nil {
		return nil, err
	}
	return LoadTokenAt(path)
}

// LoadTokenAt reads and parses the token file at path.
func LoadTokenAt(path string) (*CachedToken, error) {
	tokenMu.Lock()
	defer tokenMu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tok CachedToken
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, fmt.Errorf("load token %s: %w", path, err)
	}
	if strings.TrimSpace(tok.AccessToken) == "" {
		return nil, fmt.Errorf("load token %s: empty access_token", path)
	}
	// Backfill expiry from the JWT exp claim when the file predates the
	// ExpiresAt field or the token endpoint did not report expires_in.
	if tok.ExpiresAt.IsZero() {
		if exp, ok := jwtExpiry(tok.AccessToken); ok {
			tok.ExpiresAt = exp
		}
	}
	return &tok, nil
}

// DeleteToken removes the cached token. A missing file is not an error so
// `aw logout` is idempotent.
func DeleteToken() error {
	path, err := DefaultTokenPath()
	if err != nil {
		return err
	}
	return DeleteTokenAt(path)
}

// DeleteTokenAt removes the token file at path, treating a missing file as
// success.
func DeleteTokenAt(path string) error {
	tokenMu.Lock()
	defer tokenMu.Unlock()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// IsExpired reports whether the access token is at or past its expiry,
// accounting for the refresh skew. A zero ExpiresAt is treated as expired so
// an unparseable token is refreshed rather than trusted indefinitely.
func (t *CachedToken) IsExpired() bool {
	if t == nil {
		return true
	}
	if t.ExpiresAt.IsZero() {
		return true
	}
	return time.Now().Add(tokenRefreshSkew).After(t.ExpiresAt)
}

// TokenRefresher exchanges a refresh token for a new access token. It is an
// interface so the command layer can wire the real Better Auth token
// endpoint while tests inject a fake. The returned token is the fresh
// session; LoadValidToken persists it.
type TokenRefresher interface {
	Refresh(ctx context.Context, refreshToken string) (*CachedToken, error)
}

// TokenRefresherFunc adapts a plain function to TokenRefresher.
type TokenRefresherFunc func(ctx context.Context, refreshToken string) (*CachedToken, error)

// Refresh implements TokenRefresher.
func (f TokenRefresherFunc) Refresh(ctx context.Context, refreshToken string) (*CachedToken, error) {
	return f(ctx, refreshToken)
}

// LoadValidToken loads the cached token and, if it is expired (or about to
// expire) and a refresh token plus refresher are available, refreshes it and
// persists the result. It returns the access token string ready to drop into
// an Authorization header.
//
// Returns an error wrapping os.ErrNotExist when no token is cached (the user
// has not run `aw login`). When the token is expired and cannot be refreshed
// — no refresh token, no refresher, or a refresh failure — it returns an
// error so callers surface a clear "please run aw login" message rather than
// sending a stale bearer token.
func LoadValidToken(ctx context.Context, refresher TokenRefresher) (string, error) {
	tok, err := LoadToken()
	if err != nil {
		return "", err
	}
	if !tok.IsExpired() {
		return tok.AccessToken, nil
	}
	if strings.TrimSpace(tok.RefreshToken) == "" || refresher == nil {
		return "", fmt.Errorf("cached token expired and cannot be refreshed; run `aw login`")
	}
	refreshed, err := refresher.Refresh(ctx, tok.RefreshToken)
	if err != nil {
		return "", fmt.Errorf("refresh token: %w; run `aw login`", err)
	}
	if refreshed == nil || strings.TrimSpace(refreshed.AccessToken) == "" {
		return "", fmt.Errorf("refresh token: empty response; run `aw login`")
	}
	// Carry forward fields the refresh response may omit so the cache stays
	// complete for the next refresh cycle.
	if strings.TrimSpace(refreshed.RefreshToken) == "" {
		refreshed.RefreshToken = tok.RefreshToken
	}
	if strings.TrimSpace(refreshed.TokenURL) == "" {
		refreshed.TokenURL = tok.TokenURL
	}
	if refreshed.ExpiresAt.IsZero() {
		if exp, ok := jwtExpiry(refreshed.AccessToken); ok {
			refreshed.ExpiresAt = exp
		}
	}
	if err := SaveToken(refreshed); err != nil {
		return "", fmt.Errorf("persist refreshed token: %w", err)
	}
	return refreshed.AccessToken, nil
}

// AuthorizationHeader returns the value for an HTTP Authorization header for
// the given access token: "Bearer <token>". Returns "" for an empty token so
// callers can skip setting the header.
func AuthorizationHeader(accessToken string) string {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return ""
	}
	return "Bearer " + accessToken
}

// AttachBearer sets the Authorization header on req to the bearer token,
// loading and (if needed) refreshing the cached token. It is the single
// helper other code should call to authenticate an outgoing request with the
// SimpleAuth token cache. A missing token (os.ErrNotExist) leaves the request
// untouched and returns the error so the caller may fall back to the
// certificate auth path; other errors (expired-and-unrefreshable) are
// returned as-is.
func AttachBearer(ctx context.Context, req *http.Request, refresher TokenRefresher) error {
	token, err := LoadValidToken(ctx, refresher)
	if err != nil {
		return err
	}
	if header := AuthorizationHeader(token); header != "" {
		req.Header.Set("Authorization", header)
	}
	return nil
}

// HTTPTokenRefresher is the default TokenRefresher: it POSTs an OAuth2
// refresh-token grant to the configured token endpoint and parses the
// standard token-endpoint JSON response. Better Auth's token endpoint speaks
// the OAuth2 token response shape (access_token, refresh_token, token_type,
// expires_in), so this works without provider-specific code.
type HTTPTokenRefresher struct {
	// TokenURL is the OAuth2 token endpoint. When empty, Refresh reads the
	// token_url recorded on the cached token instead (threaded by the caller).
	TokenURL string
	// ClientID is sent as the client_id form field when non-empty.
	ClientID string
	// HTTPClient is used for the request; nil falls back to a client with a
	// finite timeout so a blackholed endpoint fails fast.
	HTTPClient *http.Client
}

// tokenEndpointResponse is the standard OAuth2 token-endpoint JSON body.
type tokenEndpointResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
}

// Refresh implements TokenRefresher against an OAuth2 token endpoint.
func (r *HTTPTokenRefresher) Refresh(ctx context.Context, refreshToken string) (*CachedToken, error) {
	tokenURL := strings.TrimSpace(r.TokenURL)
	if tokenURL == "" {
		return nil, fmt.Errorf("refresh: no token endpoint configured")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	if strings.TrimSpace(r.ClientID) != "" {
		form.Set("client_id", r.ClientID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("refresh: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	client := r.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("refresh: token endpoint returned %d", resp.StatusCode)
	}
	var body tokenEndpointResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("refresh: decode response: %w", err)
	}
	if strings.TrimSpace(body.AccessToken) == "" {
		return nil, fmt.Errorf("refresh: token endpoint returned no access_token")
	}
	tok := &CachedToken{
		AccessToken:  body.AccessToken,
		RefreshToken: body.RefreshToken,
		TokenType:    body.TokenType,
		TokenURL:     tokenURL,
	}
	if body.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(body.ExpiresIn) * time.Second)
	} else if exp, ok := jwtExpiry(body.AccessToken); ok {
		tok.ExpiresAt = exp
	}
	if sub, ok := jwtSubject(body.AccessToken); ok {
		tok.Subject = sub
	}
	return tok, nil
}

// jwtClaims is the subset of registered JWT claims this package reads. It
// only parses the payload for local expiry/subject hints; the SERVER remains
// the authority on signature, expiry, revocation, and membership. The CLI
// never trusts these claims for security decisions — they are convenience
// metadata for deciding when to refresh and what to display.
type jwtClaims struct {
	Exp     int64  `json:"exp"`
	Subject string `json:"sub"`
}

// decodeJWTClaims base64url-decodes the JWT payload segment without verifying
// the signature. It is intentionally non-validating: see jwtClaims.
func decodeJWTClaims(token string) (*jwtClaims, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// Some issuers pad; tolerate standard base64url with padding.
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, false
		}
	}
	var claims jwtClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, false
	}
	return &claims, true
}

// jwtExpiry returns the exp claim as a time, without verifying the signature.
func jwtExpiry(token string) (time.Time, bool) {
	claims, ok := decodeJWTClaims(token)
	if !ok || claims.Exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

// jwtSubject returns the sub claim, without verifying the signature.
func jwtSubject(token string) (string, bool) {
	claims, ok := decodeJWTClaims(token)
	if !ok {
		return "", false
	}
	sub := strings.TrimSpace(claims.Subject)
	if sub == "" {
		return "", false
	}
	return sub, true
}

// JWTSubjectUnverified returns the sub claim of a JWT WITHOUT verifying the
// signature. It is exported for the command layer to display who is logged in
// after `aw login`. SECURITY: never use this for an authorization decision —
// the server verifies the signature, expiry, revocation (jti), and team
// membership. This is display-only convenience metadata.
func JWTSubjectUnverified(token string) (string, bool) {
	return jwtSubject(token)
}

// JWTExpiryUnverified returns the exp claim of a JWT as a time WITHOUT
// verifying the signature. Display/cache convenience only (see the security
// note on JWTSubjectUnverified).
func JWTExpiryUnverified(token string) (time.Time, bool) {
	return jwtExpiry(token)
}
