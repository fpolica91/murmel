package main

import "testing"

// TestInjectedBearerTokenPrecedence verifies the override precedence used for
// non-interactive auth: the --token flag wins over AW_TOKEN, AW_TOKEN is used
// when the flag is empty, and both being empty yields no injected token (so the
// cached ~/.aw/token path applies).
func TestInjectedBearerTokenPrecedence(t *testing.T) {
	saved := tokenFlag
	t.Cleanup(func() { tokenFlag = saved })

	t.Run("flag beats env", func(t *testing.T) {
		tokenFlag = "flag-jwt"
		t.Setenv("AW_TOKEN", "env-jwt")
		if got := injectedBearerToken(); got != "flag-jwt" {
			t.Fatalf("expected flag to win, got %q", got)
		}
		if !hasInjectedBearerToken() {
			t.Fatal("expected hasInjectedBearerToken to be true")
		}
	})

	t.Run("env used when flag empty", func(t *testing.T) {
		tokenFlag = ""
		t.Setenv("AW_TOKEN", "env-jwt")
		if got := injectedBearerToken(); got != "env-jwt" {
			t.Fatalf("expected env token, got %q", got)
		}
	})

	t.Run("whitespace flag falls through to env", func(t *testing.T) {
		tokenFlag = "   "
		t.Setenv("AW_TOKEN", "env-jwt")
		if got := injectedBearerToken(); got != "env-jwt" {
			t.Fatalf("expected env token when flag is whitespace, got %q", got)
		}
	})

	t.Run("none set yields empty", func(t *testing.T) {
		tokenFlag = ""
		t.Setenv("AW_TOKEN", "")
		if got := injectedBearerToken(); got != "" {
			t.Fatalf("expected empty injected token, got %q", got)
		}
		if hasInjectedBearerToken() {
			t.Fatal("expected hasInjectedBearerToken to be false")
		}
	})
}
