package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/awebai/aw/awconfig"
	"github.com/spf13/cobra"
)

// `aw logout` removes the cached SimpleAuth token (~/.aw/token) written by
// `aw login`. It is idempotent: logging out when no token is cached is a
// success, not an error, so scripts can call it unconditionally.
//
// Logout is additive and only affects the bearer-token cache; it never
// touches the team-certificate auth path. After logout a workspace bound to
// a team certificate keeps working.
//
// This lane does not register the command; the rootCmd.AddCommand(logoutCmd)
// wiring is recorded in the task follow_ups for the integration step.

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Remove the cached aweb access token",
	Long: `Remove the access token cached by aw login (~/.aw/token).

logout is idempotent: it succeeds even if you were not logged in. It does
not affect team-certificate authentication.`,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		loadDotenvBestEffort()
		maybeCheckLatestVersion(cmd)
	},
	RunE: runLogout,
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}

type logoutResult struct {
	Status    string `json:"status"`
	TokenPath string `json:"token_path,omitempty"`
}

func runLogout(cmd *cobra.Command, args []string) error {
	path, err := awconfig.DefaultTokenPath()
	if err != nil {
		return err
	}

	_, statErr := os.Stat(path)
	hadToken := statErr == nil

	if err := awconfig.DeleteToken(); err != nil {
		return fmt.Errorf("logout: %w", err)
	}

	status := "logged_out"
	if !hadToken && errors.Is(statErr, os.ErrNotExist) {
		status = "not_logged_in"
	}
	printOutput(logoutResult{Status: status, TokenPath: path}, formatLogout)
	return nil
}

func formatLogout(v any) string {
	r, ok := v.(logoutResult)
	if !ok {
		return ""
	}
	var b strings.Builder
	switch r.Status {
	case "not_logged_in":
		b.WriteString("Not logged in; nothing to remove.\n")
	default:
		b.WriteString("Logged out.\n")
		if strings.TrimSpace(r.TokenPath) != "" {
			fmt.Fprintf(&b, "  removed: %s\n", r.TokenPath)
		}
	}
	return b.String()
}
