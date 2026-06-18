package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var serverFlag string
var teamFlag string
var tokenFlag string
var debugFlag bool
var jsonFlag bool

const (
	groupWorkspace    = "workspace"
	groupIdentity     = "identity"
	groupNetwork      = "network"
	groupCoordination = "coordination"
	groupObsolete     = "obsolete"
	groupUtility      = "utility"
)

var rootCmd = &cobra.Command{
	Use:   "murmel",
	Short: "Murmel CLI",
	Long:  "Murmel CLI\n\nSet AW_NO_UPDATE_CHECK=1 to disable automatic update checks.",
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		migrateLegacyConfigDirs()
		if !debugFlag && os.Getenv("AW_DEBUG") == "1" {
			debugFlag = true
		}
		loadDotenvBestEffort()
		maybeCheckLatestVersion(cmd)
	},
	SilenceUsage:  true,
	SilenceErrors: true,
}

// migrateLegacyConfigDirs renames the pre-rebrand `.aw` config locations to
// their `.murmel` equivalents so an existing install keeps its login + workspace
// after the aw->murmel rename. Best-effort + idempotent: it only renames when
// the new path is absent and the old one exists; any error is ignored.
func migrateLegacyConfigDirs() {
	// migrate moves each entry from oldPath into newPath without clobbering
	// anything already in newPath, then removes oldPath if it ends up empty.
	// Merging (rather than renaming the whole dir) is robust when newPath was
	// pre-created as a stub by a concurrent writer (e.g. a notify hook).
	migrate := func(oldPath, newPath string) {
		entries, err := os.ReadDir(oldPath)
		if err != nil {
			return // nothing to migrate
		}
		if err := os.MkdirAll(newPath, 0o700); err != nil {
			return
		}
		for _, e := range entries {
			dst := filepath.Join(newPath, e.Name())
			if _, err := os.Stat(dst); err == nil {
				continue // keep what the new location already has
			}
			_ = os.Rename(filepath.Join(oldPath, e.Name()), dst)
		}
		if rem, _ := os.ReadDir(oldPath); len(rem) == 0 {
			_ = os.Remove(oldPath)
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		migrate(filepath.Join(home, ".aw"), filepath.Join(home, ".murmel"))
		migrate(filepath.Join(home, ".config", "aw"), filepath.Join(home, ".config", "murmel"))
	}
	// Migrate the nearest legacy .aw workspace at or above the current directory.
	if wd, err := os.Getwd(); err == nil {
		dir := wd
		for {
			old := filepath.Join(dir, ".aw")
			if _, err := os.Stat(filepath.Join(old, "workspace.yaml")); err == nil {
				migrate(old, filepath.Join(dir, ".murmel"))
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		// No-op: version command doesn't require command initialization side-effects.
	},
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("murmel %s\n", version)
		if commit != "none" {
			fmt.Printf("  commit: %s\n", commit)
		}
		if date != "unknown" {
			fmt.Printf("  built:  %s\n", date)
		}
		checkLatestVersion(os.Stderr, "")
	},
}

func init() {
	rootCmd.AddGroup(
		&cobra.Group{ID: groupWorkspace, Title: "Workspace Setup"},
		&cobra.Group{ID: groupIdentity, Title: "Identity"},
		&cobra.Group{ID: groupNetwork, Title: "Messaging & Network"},
		&cobra.Group{ID: groupCoordination, Title: "Coordination & Runtime"},
		&cobra.Group{ID: groupObsolete, Title: "Obsolete / Legacy Compatibility"},
		&cobra.Group{ID: groupUtility, Title: "Utility"},
	)
	initCmd.GroupID = groupWorkspace
	resetCmd.GroupID = groupWorkspace
	workspaceCmd.GroupID = groupWorkspace
	checkCmd.GroupID = groupWorkspace

	introspectCmd.GroupID = groupIdentity
	identityCmd.GroupID = groupIdentity
	mcpConfigCmd.GroupID = groupIdentity

	chatCmd.GroupID = groupNetwork
	mailCmd.GroupID = groupNetwork
	contactsCmd.GroupID = groupNetwork
	inboundModeCmd.GroupID = groupNetwork
	directoryCmd.GroupID = groupNetwork
	a2aCmd.GroupID = groupNetwork
	heartbeatCmd.GroupID = groupNetwork
	eventsCmd.GroupID = groupNetwork
	controlCmd.GroupID = groupNetwork
	logCmd.GroupID = groupNetwork

	workCmd.GroupID = groupCoordination
	runCmd.GroupID = groupCoordination
	lockCmd.GroupID = groupCoordination
	notifyCmd.GroupID = groupCoordination
	instructionsCmd.GroupID = groupCoordination
	rolesCmd.GroupID = groupCoordination

	versionCmd.GroupID = groupUtility
	upgradeCmd.GroupID = groupUtility
	doctorCmd.GroupID = groupUtility
	rootCmd.SetHelpCommandGroupID(groupUtility)
	rootCmd.SetCompletionCommandGroupID(groupUtility)

	rootCmd.PersistentFlags().StringVar(&serverFlag, "server-name", "", "Override the server host or name for this command")
	rootCmd.PersistentFlags().StringVar(&tokenFlag, "token", "", "Bearer JWT to authenticate with (overrides AW_TOKEN and the cached ~/.murmel/token; for non-interactive use)")
	rootCmd.PersistentFlags().BoolVar(&debugFlag, "debug", false, "Log background errors to stderr")
	rootCmd.PersistentFlags().BoolVar(&jsonFlag, "json", false, "Output as JSON")
	bindTeamSelector(mailCmd)
	bindTeamSelector(chatCmd)
	bindTeamSelector(workCmd)
	bindTeamSelector(workspaceCmd)
	bindTeamSelector(checkCmd)
	bindTeamSelector(runCmd)
	bindTeamSelector(lockCmd)
	bindTeamSelector(notifyCmd)
	bindTeamSelector(instructionsCmd)
	bindTeamSelector(rolesCmd)
	bindTeamSelector(roleNameCmd)
	bindTeamSelector(heartbeatCmd)
	bindTeamSelector(eventsCmd)
	bindTeamSelector(controlCmd)
	bindTeamSelector(logCmd)
	bindTeamSelector(contactsCmd)
	bindTeamSelector(inboundModeCmd)
	bindTeamSelector(directoryCmd)
	bindTeamSelector(introspectCmd)
	bindTeamSelector(doctorCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(upgradeCmd)
	rootCmd.AddCommand(a2aCmd)
}

func bindTeamSelector(cmd *cobra.Command) {
	if cmd == nil {
		return
	}
	cmd.PersistentFlags().StringVar(&teamFlag, "team", "", "Override the selected team_id for this command")
}

func Execute() {
	err := rootCmd.Execute()
	checkVersionFromHeader()
	if err != nil {
		msg := err.Error()
		if hint := checkVerificationRequired(err); hint != "" {
			msg = hint
		}
		fmt.Fprintln(os.Stderr, msg)
		os.Exit(exitCode(err))
	}
}

// checkVersionFromHeader prints a stderr warning if the server reported
// a newer client version via the X-Latest-Client-Version response header.
func checkVersionFromHeader() {
	if lastClient == nil {
		return
	}
	latest := lastClient.LatestClientVersion()
	if latest == "" {
		return
	}
	current := strings.TrimPrefix(version, "v")
	if current == "dev" || current == "" {
		return
	}
	latest = strings.TrimPrefix(latest, "v")
	if compareVersions(current, latest) < 0 {
		fmt.Fprintf(os.Stderr, "Upgrade available: v%s → v%s (run `murmel upgrade`)\n", current, latest)
	}
}
