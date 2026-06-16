package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize this directory as an aw workspace",
	Long: `Initialize the current directory as a token-authenticated aw workspace.

Authentication is by bearer token (no team certificate):

- run "aw login" first to cache a token at ~/.aw/token, or
- pass --token <jwt> / set AW_TOKEN for non-interactive use (CI, scripts).

init writes a cert-less .aw/workspace.yaml bound to --team on the --aweb-url
server, plus a local self-custodial signing key for end-to-end encrypted
messaging (never used for server auth).

By default, init creates or updates the clearly marked aweb section in
AGENTS.md or CLAUDE.md. Use --do-not-touch-agents-md to skip that file update.`,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		loadDotenvBestEffort()
		maybeCheckLatestVersion(cmd)
		// No heartbeat for init — no credentials yet.
	},
	RunE: runInit,
}

var (
	initURL                string
	initAwebURL            string
	initAWIDRegistry       string
	initBYOD               bool
	initUsername           string
	initDomain             string
	initAlias              string
	initName               string
	initInjectDocs         bool
	initSetupHooks         bool
	initSetupChannel       bool
	initDoNotTouchAgentsMD bool
	initHumanName          string
	initAgentType          string
	initWriteContext       bool
	initPrintExports       bool
	initRole               string
	initPersistent         bool
	initInboundMode        string
	initTeam               string
)

var (
	initIsTTY                      = isTTY
	initPrintGuidedOnboardingReady = printGuidedOnboardingReadyMessage
	initRunImplicitLocalFlow       = runImplicitLocalInit
)

type initResult struct {
	ServerName    string
	ExportBaseURL string
	Alias         string
	// APIKeyAuth is true when init succeeded via an API key bootstrap.
	// API keys are minted from an authenticated context (dashboard or
	// programmatic), so the actor already has an account; suggesting
	// `aw claim-human` is misleading. Other init paths leave this false
	// and the claim-human suggestion fires per shouldSuggestClaimHuman.
	APIKeyAuth bool
}

func init() {
	initCmd.Flags().StringVar(&initURL, "url", "", "Base URL for the aweb server used for init, bootstrap, and hosted onboarding flows")
	initCmd.Flags().StringVar(&initAwebURL, "aweb-url", "", "Base URL for the aweb server used by aw init (overrides AWEB_URL)")
	initCmd.Flags().StringVar(&initAWIDRegistry, "awid-registry", "", "Base URL for the awid registry used by aw init (overrides AWID_REGISTRY_URL)")
	initCmd.Flags().BoolVar(&initBYOD, "byod", false, "Use a domain you control instead of hosted aweb.ai onboarding")
	initCmd.Flags().StringVar(&initUsername, "username", "", "Hosted username to create")
	initCmd.Flags().StringVar(&initDomain, "domain", "", "BYOD domain to use with --byod")
	initCmd.Flags().StringVar(&initTeam, "team", "", "Team ID to bind this workspace to (e.g. default:local). Defaults to AWEB_TEAM_ID.")
	initCmd.Flags().StringVar(&initAlias, "alias", "", "Local workspace routing alias (optional; default: server-suggested)")
	initCmd.Flags().StringVar(&initName, "name", "", "Global identity name (required with --global unless .aw/identity.yaml already exists)")
	initCmd.Flags().BoolVar(&initInjectDocs, "inject-docs", false, "Inject aw coordination instructions into CLAUDE.md and AGENTS.md")
	initCmd.Flags().BoolVar(&initDoNotTouchAgentsMD, "do-not-touch-agents-md", false, "Do not create or update AGENTS.md or CLAUDE.md during init")
	initCmd.Flags().BoolVar(&initSetupHooks, "setup-hooks", false, "Set up Claude Code PostToolUse hook for aw notify")
	initCmd.Flags().BoolVar(&initSetupChannel, "setup-channel", false, "Set up Claude Code channel MCP server for real-time coordination")
	initCmd.Flags().StringVar(&initHumanName, "human-name", "", "Human name (default: AWEB_HUMAN or $USER)")
	initCmd.Flags().StringVar(&initAgentType, "agent-type", "", "Runtime type (default: AWEB_AGENT_TYPE or agent)")
	initCmd.Flags().BoolVar(&initWriteContext, "write-context", true, "Ensure .aw/context exists in the current directory")
	initCmd.Flags().BoolVar(&initPrintExports, "print-exports", false, "Print shell export lines after JSON output")
	addWorkspaceRoleFlags(initCmd, &initRole, "Workspace role name (must match a role in the active team roles bundle)")
	initCmd.Flags().BoolVar(&initPersistent, "global", false, "Create an addressed self-custodial global identity instead of the default local workspace")
	initCmd.Flags().BoolVar(&initPersistent, "persistent", false, "Compatibility alias for --global")
	_ = initCmd.Flags().MarkHidden("persistent")
	initCmd.Flags().StringVar(&initInboundMode, "inbound-mode", "", "Inbound delivery mode for a global identity (open|team-and-contacts). Only valid with --global.")

	rootCmd.AddCommand(initCmd)
}

func addWorkspaceRoleFlags(cmd *cobra.Command, target *string, description string) {
	cmd.Flags().StringVar(target, "role-name", "", description)
	cmd.Flags().StringVar(target, "role", "", "Compatibility alias for --role-name")
}

func runInit(cmd *cobra.Command, args []string) error {
	if initSetupChannel && initSetupHooks {
		return fmt.Errorf("--setup-channel and --setup-hooks are mutually exclusive: the channel supersedes the notify hook")
	}
	if initInjectDocs && initDoNotTouchAgentsMD {
		return fmt.Errorf("--inject-docs and --do-not-touch-agents-md are mutually exclusive")
	}
	if err := validateInitInboundMode(); err != nil {
		return err
	}

	// When only --inject-docs, --setup-hooks, or --setup-channel are requested,
	// operate on the existing workspace without running the full init flow.
	if (initInjectDocs || initSetupHooks || initSetupChannel) && !initNeedsFullInitForAddonOnly() {
		wd, _ := os.Getwd()
		repoRoot := resolveRepoRoot(wd)
		if initInjectDocs {
			printInjectDocsResult(InjectAgentDocs(repoRoot))
		}
		if initSetupChannel {
			channelResult := SetupChannelMCP(repoRoot, initIsTTY())
			printChannelMCPResult(channelResult)
		}
		if initSetupHooks {
			hookResult := SetupClaudeHooks(repoRoot, initIsTTY())
			printClaudeHooksResult(hookResult)
		}
		return nil
	}

	if err := rejectRemovedInitFlags(); err != nil {
		return err
	}

	wd, _ := os.Getwd()
	workspaceMissing, err := initWorkspaceMissing(wd)
	if err != nil {
		return err
	}
	if !workspaceMissing {
		return usageError("this directory already has a workspace; use a fresh directory")
	}

	awebURL, err := resolveInitAwebURL()
	if err != nil {
		return err
	}
	teamID, err := resolveInitTeamID()
	if err != nil {
		return err
	}

	result, err := initTokenWorkspace(cmd.Context(), tokenInitOptions{
		WorkingDir:   wd,
		AwebURL:      awebURL,
		TeamID:       teamID,
		Alias:        resolveAliasValue(strings.TrimSpace(initAlias)),
		RoleName:     resolveRequestedRole(strings.TrimSpace(initRole)),
		HumanName:    resolveHumanNameValue(strings.TrimSpace(initHumanName)),
		AgentType:    resolveAgentTypeValue(strings.TrimSpace(initAgentType)),
		WriteContext: initWriteContext,
	})
	if err != nil {
		return err
	}
	printOutput(result, formatConnect)
	didInjectDocs := runDefaultInitDocsInjection(wd)
	if !jsonFlag {
		printPostInitActions(&initResult{
			ServerName:    hostFromBaseURL(result.AwebURL),
			ExportBaseURL: result.AwebURL,
			Alias:         strings.TrimSpace(result.Alias),
		}, wd, didInjectDocs)
	}
	return nil
}

// resolveInitTeamID resolves the team_id to bind, from --team or AWEB_TEAM_ID.
func resolveInitTeamID() (string, error) {
	value := strings.TrimSpace(initTeam)
	if value == "" {
		value = strings.TrimSpace(os.Getenv("AWEB_TEAM_ID"))
	}
	if value == "" {
		return "", usageError("a team is required: pass --team <team_id> (e.g. default:local) or set AWEB_TEAM_ID")
	}
	return value, nil
}

// rejectRemovedInitFlags turns the certificate/registry-only flags into clear
// usage errors pointing at the token flow, now that init authenticates by
// bearer token only.
func rejectRemovedInitFlags() error {
	switch {
	case initBYOD:
		return usageError("--byod is no longer supported: aw init authenticates by token; run `aw login` (or pass --token) and use --team")
	case initPersistent:
		return usageError("--global/--persistent is no longer supported: aw init authenticates by token; run `aw login` (or pass --token) and use --team")
	case strings.TrimSpace(initUsername) != "":
		return usageError("--username is no longer supported: aw init authenticates by token; run `aw login` (or pass --token)")
	case strings.TrimSpace(initDomain) != "":
		return usageError("--domain is no longer supported: aw init authenticates by token; run `aw login` (or pass --token)")
	case strings.TrimSpace(initInboundMode) != "":
		return usageError("--inbound-mode is no longer supported: aw init authenticates by token")
	case strings.TrimSpace(initAWIDRegistry) != "":
		return usageError("--awid-registry is no longer supported: aw init authenticates by token; no registry is contacted")
	case strings.TrimSpace(initName) != "":
		return usageError("--name is no longer supported: aw init authenticates by token; run `aw login` (or pass --token)")
	}
	return nil
}

func initHasExplicitOnboardingArgs() bool {
	values := []string{
		initUsername,
		initDomain,
		initAlias,
		initName,
	}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return initBYOD || initPersistent
}

func resolveInitAwebURL() (string, error) {
	value := resolveInitAwebURLOverride()
	if value == "" {
		value = DefaultAwebURL
	}
	return normalizeAwebBaseURL(value)
}

func resolveExplicitInitAwebURL() (string, error) {
	value := resolveInitAwebURLOverride()
	if value == "" {
		workingDir, err := os.Getwd()
		if err != nil {
			return "", err
		}
		discovered, ok, err := resolveDefaultCertificateInitAwebURL(workingDir)
		if err != nil {
			return "", err
		}
		if ok {
			return discovered, nil
		}
		return "", usageError("--aweb-url, --url, or AWEB_URL is required when using certificate auth (team certificate found under .aw/team-certs/)")
	}
	return normalizeAwebBaseURL(value)
}

func resolveDefaultCertificateInitAwebURL(workingDir string) (string, bool, error) {
	cert, _, err := loadCertificateForConnect(workingDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	teamDomain, _, err := awid.ParseTeamID(strings.TrimSpace(cert.Team))
	if err != nil {
		return "", false, fmt.Errorf("current team certificate has invalid team_id %q: %w", cert.Team, err)
	}
	if workspace, _, err := awconfig.LoadWorktreeWorkspaceFromDir(workingDir); err == nil && workspace != nil {
		if awebURL := strings.TrimSpace(workspace.AwebURL); awebURL != "" {
			if workspace.Membership(strings.TrimSpace(cert.Team)) != nil || len(workspace.Memberships) == 0 {
				normalized, err := normalizeAwebBaseURL(awebURL)
				if err != nil {
					return "", false, fmt.Errorf("invalid aweb_url for team %s: %w", cert.Team, err)
				}
				return normalized, true, nil
			}
		}
	} else if err != nil && !os.IsNotExist(err) {
		return "", false, err
	}
	if teamState, err := awconfig.LoadTeamState(workingDir); err == nil && teamState != nil {
		if membership := teamState.Membership(strings.TrimSpace(cert.Team)); membership != nil {
			if awebURL := strings.TrimSpace(membership.AwebURL); awebURL != "" {
				normalized, err := normalizeAwebBaseURL(awebURL)
				if err != nil {
					return "", false, fmt.Errorf("invalid aweb_url for team %s: %w", cert.Team, err)
				}
				return normalized, true, nil
			}
		}
	} else if err != nil && !os.IsNotExist(err) {
		return "", false, err
	}
	registryURL, err := resolveWorkspaceTeamRegistryURL(workingDir, "", teamDomain)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	if strings.TrimSpace(registryURL) != awid.DefaultAWIDRegistryURL {
		return "", false, nil
	}
	awebURL, err := cleanBaseURL(DefaultAwebURL + "/api")
	if err != nil {
		return "", false, err
	}
	return awebURL, true, nil
}

func resolveInitAwebURLOverride() string {
	value := strings.TrimSpace(initAwebURL)
	if value == "" {
		value = strings.TrimSpace(initURL)
	}
	if value == "" {
		value = strings.TrimSpace(os.Getenv("AWEB_URL"))
	}
	return value
}

func resolveInitAWIDRegistryURL() (string, error) {
	value := strings.TrimSpace(initAWIDRegistry)
	if value == "" {
		value = strings.TrimSpace(os.Getenv("AWID_REGISTRY_URL"))
	}
	if value == "" {
		value = awid.DefaultAWIDRegistryURL
	}
	if strings.EqualFold(value, "local") {
		return "", usageError("AWID_REGISTRY_URL=local is not supported by `aw init`; use an explicit localhost URL such as http://localhost:8010")
	}
	return cleanBaseURL(value)
}

func initBaseURLIsLocalhost(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.TrimSpace(u.Hostname())
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func initRegistryIsLocalhost(raw string) bool {
	return initBaseURLIsLocalhost(raw)
}

func initShouldUseImplicitLocalFlow(registryURL string) bool {
	if !initRegistryIsLocalhost(registryURL) {
		return false
	}
	// The implicit local flow is the compatibility path for a local aweb+awid
	// stack. Explicit onboarding inputs mean the user is asking for hosted/BYOD
	// semantics even if the test or dev stack happens to be on localhost.
	return !initBYOD &&
		strings.TrimSpace(initUsername) == "" &&
		strings.TrimSpace(initDomain) == "" &&
		strings.TrimSpace(initName) == "" &&
		!initPersistent
}

// initNeedsFullInitForAddonOnly returns true when an add-on request must
// escalate to full init because it changes identity/team state or has no
// existing workspace to operate on.
func initNeedsFullInitForAddonOnly() bool {
	if initBYOD || initUsername != "" || initDomain != "" || initAlias != "" || initName != "" || initRole != "" || initPersistent {
		return true
	}
	wd, _ := os.Getwd()
	missing, _ := initWorkspaceMissing(wd)
	return missing
}

func initWorkspaceMissing(workingDir string) (bool, error) {
	_, _, err := awconfig.LoadWorktreeWorkspaceFromDir(workingDir)
	if err == nil {
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("invalid local workspace binding: %w", err)
	}
	return true, nil
}

func printGuidedOnboardingReadyMessage(result *guidedOnboardingResult) {
	if result == nil {
		return
	}
	fmt.Println()
	fmt.Println("Workspace ready.")
	fmt.Println()
	fmt.Println("Tell your agent: please read https://aweb.ai/docs/cli-tutorial.md")
	fmt.Println()
	printChannelLaunchInstructions(os.Stdout)
}

func printChannelLaunchInstructions(out io.Writer) {
	fmt.Fprintln(out, "To use the channel directly inside Claude Code (real-time coordination):")
	fmt.Fprintln(out, "  /plugin marketplace add awebai/claude-plugins")
	fmt.Fprintln(out, "  /plugin install aweb-channel@awebai-marketplace")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Then start Claude Code with the channel enabled:")
	fmt.Fprintln(out, "  claude --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Note: Claude Code will warn that --dangerously-load-development-channels is a")
	fmt.Fprintln(out, "security risk and ask you to confirm. That warning is expected — channels are")
	fmt.Fprintln(out, "still in beta. Confirm to enable.")
}

func resolveHumanName() string {
	return resolveHumanNameValue(strings.TrimSpace(initHumanName))
}

func resolveHumanNameValue(value string) string {
	if v := strings.TrimSpace(value); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("AWEB_HUMAN")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("AWEB_HUMAN_NAME")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("USER")); v != "" {
		return v
	}
	return "developer"
}

func resolveAgentType() string {
	return resolveAgentTypeValue(strings.TrimSpace(initAgentType))
}

func resolveAgentTypeValue(value string) string {
	if v := strings.TrimSpace(value); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("AWEB_AGENT_TYPE")); v != "" {
		return v
	}
	return "agent"
}

func resolveAliasValue(explicit string) string {
	if v := strings.TrimSpace(explicit); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("AWEB_ALIAS"))
}

// validateInitInboundMode enforces the aapl.7 contract on the
// --inbound-mode flag. The user-facing flag values use the
// hyphen-spelling CLI convention (open, team-and-contacts); the
// underscored canonical form (team_and_contacts) is the wire-level value
// translated by canonicalInitInboundModeForWire before the API call.
//
// Per Juan c2d25276: --inbound-mode is a real top-level flag of
// `aw init --global` and every supported global creation path
// (API-key bootstrap, guided hosted onboarding, BYOD) must forward
// the value into the create call. This validator only enforces the
// flag-shape contract; threading through the paths is the runner's
// responsibility.
//
// Two guards:
//
//  1. The flag is only meaningful for a global identity (--global);
//     local workspaces have no inbound delivery mode.
//  2. Only the two-value set {open, team-and-contacts} is canonical.
//     The stale contacts-only spelling is accepted as a compatibility
//     alias and normalized to team-and-contacts. The withdrawn value
//     "contacts_or_teammates" (or the hyphenated variant) must fail at
//     parse time so users copying stale commands see a clear error.
func validateInitInboundMode() error {
	value := strings.TrimSpace(initInboundMode)
	if value == "" {
		return nil
	}
	if !initPersistent {
		return fmt.Errorf("--inbound-mode is only valid with --global; local workspaces do not have an inbound delivery mode")
	}
	if initBYOD {
		// BYOD creates the team certificate locally; there is no
		// hosted creation endpoint at this stage to carry the
		// inbound_mode value. Fail fast instead of silently
		// dropping the user's choice (Juan c2d25276: "fail only
		// where the path genuinely cannot create/configure a
		// global identity"). The user can set the mode after the
		// BYOD identity is up via the dashboard's inbound-mode
		// surface or the hosted REST API
		// (`aw inbound-mode <mode>`).
		return fmt.Errorf("--inbound-mode is not supported on --byod global creation today (no server-side creation endpoint to carry the value); run `aw init --byod --global` first, then set the inbound mode from the dashboard or with `aw inbound-mode <open|team-and-contacts>`")
	}
	switch value {
	case "open":
		initInboundMode = "open"
		return nil
	case "team-and-contacts", "contacts-only":
		initInboundMode = "team-and-contacts"
		return nil
	}
	return fmt.Errorf("--inbound-mode must be one of {open, team-and-contacts}; got %q", value)
}

// canonicalInitInboundModeForWire translates the user-facing
// flag value into the canonical wire form expected by the API:
// "team-and-contacts" → "team_and_contacts". Returns "" when no value was set.
func canonicalInitInboundModeForWire(flag string) string {
	switch strings.TrimSpace(flag) {
	case "":
		return ""
	case "open":
		return "open"
	case "team-and-contacts", "contacts-only":
		return "team_and_contacts"
	}
	// Should be unreachable after validateInitInboundMode; defensive only.
	return strings.TrimSpace(flag)
}

func resolveRequestedRole(explicit string) string {
	if v := strings.TrimSpace(explicit); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("AWEB_ROLE_NAME")); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("AWEB_ROLE"))
}

func runDefaultInitDocsInjection(workingDir string) bool {
	if jsonFlag || initDoNotTouchAgentsMD || initInjectDocs {
		return false
	}
	repoRoot := resolveRepoRoot(workingDir)
	printInjectDocsResult(InjectAgentDocs(repoRoot))
	return true
}

func printPostInitActions(result *initResult, workingDir string, didDefaultInjectDocs bool) {
	if initPrintExports {
		fmt.Println("")
		fmt.Println("# Copy/paste to configure your shell:")
		fmt.Println("export AWEB_URL=" + result.ExportBaseURL)
		if strings.TrimSpace(result.Alias) != "" {
			fmt.Println("export AWEB_ALIAS=" + result.Alias)
		}
	}
	repoRoot := resolveRepoRoot(workingDir)
	if initInjectDocs {
		printInjectDocsResult(InjectAgentDocs(repoRoot))
	}
	if initSetupChannel {
		channelResult := SetupChannelMCP(repoRoot, isTTY())
		printChannelMCPResult(channelResult)
	}
	if initSetupHooks {
		hookResult := SetupClaudeHooks(repoRoot, isTTY())
		printClaudeHooksResult(hookResult)
	}
	if !jsonFlag {
		printInitNextSteps(result, workingDir, initInjectDocs || didDefaultInjectDocs, initSetupHooks, initSetupChannel)
	}
}

func printInitNextSteps(result *initResult, workingDir string, didInjectDocs, didSetupHooks, didSetupChannel bool) {
	lines := initNextStepLines(result, workingDir, didInjectDocs, didSetupHooks, didSetupChannel)
	if len(lines) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("Next steps:")
	for _, line := range lines {
		fmt.Println(line)
	}
}

func initNextStepLines(result *initResult, workingDir string, didInjectDocs, didSetupHooks, didSetupChannel bool) []string {
	var lines []string

	if !didSetupChannel {
		lines = append(lines, formatInitNextStep("aw init --setup-channel", "Set up Claude Code channel for real-time coordination"))
	}
	if !didInjectDocs {
		lines = append(lines, formatInitNextStep("aw init --inject-docs", "Add coordination instructions to CLAUDE.md / AGENTS.md"))
	}
	if shouldSuggestClaimHuman(result) {
		lines = append(lines, formatInitNextStep("aw claim-human --email you@example.com", "Attach your human account for dashboard access"))
	}

	lines = append(lines, "")
	lines = append(lines, "  Install the channel directly inside Claude Code (real-time coordination):")
	lines = append(lines, "    /plugin marketplace add awebai/claude-plugins")
	lines = append(lines, "    /plugin install aweb-channel@awebai-marketplace")
	lines = append(lines, "")
	lines = append(lines, "  Then start Claude Code with the channel enabled:")
	lines = append(lines, "    claude --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace")
	lines = append(lines, "")
	lines = append(lines, "  Tell your agent: please read https://aweb.ai/docs/cli-tutorial.md")
	return lines
}

func formatInitNextStep(command, description string) string {
	return fmt.Sprintf("  %-36s %s", command, description)
}

func shouldSuggestClaimHuman(result *initResult) bool {
	if result == nil {
		return false
	}
	// API-key bootstrap implies the actor already has an account: API keys
	// are minted from authenticated contexts (dashboard or programmatic).
	// Suggesting claim-human in that case is misleading.
	if result.APIKeyAuth {
		return false
	}
	values := []string{result.ServerName, result.ExportBaseURL}
	for _, value := range values {
		lower := strings.ToLower(strings.TrimSpace(value))
		if lower == "" {
			continue
		}
		if strings.Contains(lower, "app.aweb.ai") || strings.Contains(lower, "aweb.ai") {
			return true
		}
	}
	return false
}

func normalizeAwebBaseURL(baseURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimSuffix(u.String(), "/"), nil
}

func hostFromBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(u.Hostname()))
}
