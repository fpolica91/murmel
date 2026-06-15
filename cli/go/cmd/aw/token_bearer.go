package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	aweb "github.com/awebai/aw"
	"github.com/awebai/aw/awconfig"
)

// mintJWTFromSession exchanges a Better Auth session token for a short-lived
// JWKS-verifiable JWT at tokenURL (GET with the session as a Bearer credential,
// enabled by Better Auth's bearer plugin). It is shared by `aw login` (initial
// exchange) and the SimpleAuth refresher (re-mint on expiry), so both stay
// symmetric. The session is preserved as the refresh credential.
func mintJWTFromSession(ctx context.Context, tokenURL, sessionToken string) (*awconfig.CachedToken, error) {
	tokenURL = strings.TrimSpace(tokenURL)
	if tokenURL == "" {
		return nil, fmt.Errorf("no token endpoint recorded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build mint request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("mint failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}

	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode mint response: %w", err)
	}
	jwt := strings.TrimSpace(out.Token)
	if jwt == "" {
		return nil, fmt.Errorf("token endpoint returned no token")
	}

	tok := &awconfig.CachedToken{
		AccessToken:  jwt,
		RefreshToken: sessionToken,
		TokenType:    "Bearer",
		TokenURL:     tokenURL,
	}
	if exp, ok := awconfig.JWTExpiryUnverified(jwt); ok {
		tok.ExpiresAt = exp
	}
	if sub, ok := awconfig.JWTSubjectUnverified(jwt); ok {
		tok.Subject = sub
	}
	return tok, nil
}

// sessionRefresher implements awconfig.TokenRefresher by re-minting a JWT from
// the cached session token at the cached token endpoint.
type sessionRefresher struct{}

func (sessionRefresher) Refresh(ctx context.Context, refreshToken string) (*awconfig.CachedToken, error) {
	cached, err := awconfig.LoadToken()
	if err != nil {
		return nil, err
	}
	return mintJWTFromSession(ctx, cached.TokenURL, refreshToken)
}

// bearerTokenProvider returns a valid (auto-refreshed) SimpleAuth JWT for the
// current user, or an error wrapping os.ErrNotExist when no token is cached
// (the user has not run `aw login`). Installed on the coordination client via
// SetBearerProvider so every command auto-attaches the token when no team
// certificate is present.
func bearerTokenProvider(ctx context.Context) (string, error) {
	return awconfig.LoadValidToken(ctx, sessionRefresher{})
}

// bearerClientIfAvailable builds a coordination client that authenticates with
// the cached SimpleAuth (Better Auth) JWT, for when a workspace resolves but
// has no team certificate. Returns an error wrapping os.ErrNotExist when no
// token is cached, so callers fall back to the certificate-auth error.
func bearerClientIfAvailable(baseURL, teamID string) (*aweb.Client, error) {
	if _, err := awconfig.LoadToken(); err != nil {
		return nil, err
	}
	c, err := aweb.New(baseURL)
	if err != nil {
		return nil, err
	}
	c.SetTeamID(teamID)
	c.SetBearerProvider(bearerTokenProvider)
	return c, nil
}
