package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	aweb "github.com/awebai/aw"
	"github.com/spf13/cobra"
)

// `murmel memory` — terminal access to the team's shared knowledge notes,
// complementing the REST memory API. Like `murmel issue`, it works with both
// team-certificate and `murmel login` (bearer) auth; the team is derived
// server-side from the token, never sent in the request body.

var memoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "Save and search team knowledge notes",
}

var memorySearchCmd = &cobra.Command{
	Use:     "search",
	Aliases: []string{"list"},
	Short:   "Search team memories (empty query lists most recent)",
	RunE:    runMemorySearch,
}

var memorySaveCmd = &cobra.Command{
	Use:   "save",
	Short: "Save a new team memory",
	RunE:  runMemorySave,
}

var memoryGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Show one memory in full",
	Args:  cobra.ExactArgs(1),
	RunE:  runMemoryGet,
}

var memoryUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Update a memory's title, body, or tags",
	Args:  cobra.ExactArgs(1),
	RunE:  runMemoryUpdate,
}

var memoryDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a memory",
	Args:  cobra.ExactArgs(1),
	RunE:  runMemoryDelete,
}

func init() {
	memorySearchCmd.Flags().StringP("query", "q", "", "Full-text search query (empty lists most recent)")
	memorySearchCmd.Flags().String("tag", "", "Filter by tags (comma-separated)")
	memorySearchCmd.Flags().Int("limit", 20, "Maximum number of memories to return")

	memorySaveCmd.Flags().String("title", "", "Memory title (required)")
	memorySaveCmd.Flags().String("body", "", "Memory body (markdown)")
	memorySaveCmd.Flags().String("tags", "", "Tags (comma-separated)")
	memorySaveCmd.Flags().String("private", "", "Restrict to an assignee alias (private memory)")
	_ = memorySaveCmd.MarkFlagRequired("title")

	memoryUpdateCmd.Flags().String("title", "", "New title (empty = unchanged)")
	memoryUpdateCmd.Flags().String("body", "", "New body (empty = unchanged)")
	memoryUpdateCmd.Flags().String("tags", "", "New tags, comma-separated (empty = unchanged)")

	memoryDeleteCmd.Flags().BoolP("yes", "y", false, "Skip the confirmation prompt")

	memoryCmd.AddCommand(
		memorySearchCmd, memorySaveCmd, memoryGetCmd,
		memoryUpdateCmd, memoryDeleteCmd,
	)
	rootCmd.AddCommand(memoryCmd)
}

func memoryClient() (*aweb.Client, context.Context, context.CancelFunc, error) {
	client, err := resolveClient()
	if err != nil {
		return nil, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	return client, ctx, cancel, nil
}

func runMemorySearch(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := memoryClient()
	if err != nil {
		return err
	}
	defer cancel()

	query, _ := cmd.Flags().GetString("query")
	tags, _ := cmd.Flags().GetString("tag")
	limit, _ := cmd.Flags().GetInt("limit")

	resp, err := client.MemorySearch(ctx, query, tags, "", limit)
	if err != nil {
		return fmt.Errorf("searching memories: %w", err)
	}
	printOutput(resp, func(v any) string {
		r := v.(*aweb.MemoryListResponse)
		if len(r.Memories) == 0 {
			return "No memories found.\n"
		}
		var sb strings.Builder
		for _, m := range r.Memories {
			sb.WriteString(formatMemoryLine(m))
			sb.WriteString("\n")
		}
		return sb.String()
	})
	return nil
}

func runMemorySave(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := memoryClient()
	if err != nil {
		return err
	}
	defer cancel()

	title, _ := cmd.Flags().GetString("title")
	body, _ := cmd.Flags().GetString("body")
	tags, _ := cmd.Flags().GetString("tags")
	private, _ := cmd.Flags().GetString("private")

	mem, err := client.MemorySave(ctx, title, body, tags, private)
	if err != nil {
		return fmt.Errorf("saving memory: %w", err)
	}
	printOutput(mem, func(v any) string {
		m := v.(*aweb.Memory)
		return fmt.Sprintf("Saved %s — %s\n", m.MemoryID, m.Title)
	})
	return nil
}

func runMemoryGet(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := memoryClient()
	if err != nil {
		return err
	}
	defer cancel()

	mem, err := client.MemoryGet(ctx, args[0])
	if err != nil {
		return fmt.Errorf("getting memory: %w", err)
	}
	printOutput(mem, formatMemoryDetail)
	return nil
}

func runMemoryUpdate(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := memoryClient()
	if err != nil {
		return err
	}
	defer cancel()

	title, _ := cmd.Flags().GetString("title")
	body, _ := cmd.Flags().GetString("body")
	tags, _ := cmd.Flags().GetString("tags")

	mem, err := client.MemoryUpdate(ctx, args[0], title, body, tags)
	if err != nil {
		return fmt.Errorf("updating memory: %w", err)
	}
	printOutput(mem, func(v any) string {
		m := v.(*aweb.Memory)
		return fmt.Sprintf("Updated %s — %s\n", m.MemoryID, m.Title)
	})
	return nil
}

func runMemoryDelete(cmd *cobra.Command, args []string) error {
	id := args[0]
	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		if !confirmMemoryDelete(id) {
			fmt.Fprintln(os.Stderr, "Aborted.")
			return nil
		}
	}

	client, ctx, cancel, err := memoryClient()
	if err != nil {
		return err
	}
	defer cancel()

	if err := client.MemoryDelete(ctx, id); err != nil {
		return fmt.Errorf("deleting memory: %w", err)
	}
	printOutput(map[string]string{"deleted": id}, func(v any) string {
		return fmt.Sprintf("Deleted %s\n", id)
	})
	return nil
}

// confirmMemoryDelete prompts on the terminal before a destructive delete.
// A non-terminal stdin (piped/CI) declines unless --yes was passed.
func confirmMemoryDelete(id string) bool {
	if !readerIsTerminal(os.Stdin) {
		fmt.Fprintln(os.Stderr, "Refusing to delete without confirmation; re-run with --yes.")
		return false
	}
	reader := bufferedPromptReader(os.Stdin)
	fmt.Fprintf(os.Stderr, "Delete memory %s? [y/N]: ", id)
	line, err := reader.ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}

func formatMemoryLine(m aweb.Memory) string {
	tags := ""
	if len(m.Tags) > 0 {
		tags = "  #" + strings.Join(m.Tags, " #")
	}
	updated := formatTimeAgo(m.UpdatedAt)
	private := ""
	if strings.TrimSpace(m.AssigneeAlias) != "" {
		private = " 🔒" + strings.TrimSpace(m.AssigneeAlias)
	}
	return fmt.Sprintf("○ %s  %s — by %s%s  (%s)%s",
		m.MemoryID, m.Title, memoryAuthor(m), tags, updated, private)
}

func formatMemoryDetail(v any) string {
	m := v.(*aweb.Memory)
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s — %s\n", m.MemoryID, m.Title)
	fmt.Fprintf(&sb, "Author: %s\n", memoryAuthor(*m))
	if strings.TrimSpace(m.AssigneeAlias) != "" {
		fmt.Fprintf(&sb, "Private to: %s\n", strings.TrimSpace(m.AssigneeAlias))
	}
	if len(m.Tags) > 0 {
		fmt.Fprintf(&sb, "Tags: %s\n", strings.Join(m.Tags, ", "))
	}
	fmt.Fprintf(&sb, "Updated: %s\n", formatTimeAgo(m.UpdatedAt))
	if strings.TrimSpace(m.BodyMD) != "" {
		fmt.Fprintf(&sb, "\n%s\n", strings.TrimRight(m.BodyMD, "\n"))
	}
	return sb.String()
}

func memoryAuthor(m aweb.Memory) string {
	if a := strings.TrimSpace(m.CreatedByAlias); a != "" {
		return a
	}
	return "unknown"
}
