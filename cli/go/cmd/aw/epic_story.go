package main

import (
	"fmt"
	"strings"

	aweb "github.com/awebai/aw"
	"github.com/spf13/cobra"
)

// `aw epic` / `aw story` — organize the work hierarchy from the terminal,
// complementing `aw issue` and the UI.

var epicCmd = &cobra.Command{Use: "epic", Short: "Manage epics"}
var storyCmd = &cobra.Command{Use: "story", Short: "Manage stories"}

var epicListCmd = &cobra.Command{
	Use: "list", Short: "List epics", RunE: runEpicList,
}
var epicCreateCmd = &cobra.Command{
	Use: "create <title>", Short: "Create an epic", Args: cobra.MinimumNArgs(1), RunE: runEpicCreate,
}
var storyListCmd = &cobra.Command{
	Use: "list", Short: "List stories", RunE: runStoryList,
}
var storyCreateCmd = &cobra.Command{
	Use: "create <title>", Short: "Create a story", Args: cobra.MinimumNArgs(1), RunE: runStoryCreate,
}

func init() {
	storyCreateCmd.Flags().String("epic", "", "Parent epic id")
	epicCmd.AddCommand(epicListCmd, epicCreateCmd)
	storyCmd.AddCommand(storyListCmd, storyCreateCmd)
	rootCmd.AddCommand(epicCmd, storyCmd)
}

func runEpicList(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()
	resp, err := client.EpicList(ctx)
	if err != nil {
		return fmt.Errorf("listing epics: %w", err)
	}
	printOutput(resp, func(v any) string {
		r := v.(*aweb.EpicListResponse)
		if len(r.Epics) == 0 {
			return "No epics found.\n"
		}
		var sb strings.Builder
		for _, e := range r.Epics {
			sb.WriteString(fmt.Sprintf("◆ %s [%s] %s\n", e.EpicID, strings.ToUpper(e.Status), e.Title))
		}
		return sb.String()
	})
	return nil
}

func runEpicCreate(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()
	epic, err := client.EpicCreate(ctx, &aweb.EpicCreateRequest{Title: strings.Join(args, " ")})
	if err != nil {
		return fmt.Errorf("creating epic: %w", err)
	}
	printOutput(epic, func(v any) string {
		e := v.(*aweb.Epic)
		return fmt.Sprintf("Created epic %s — %s\n", e.EpicID, e.Title)
	})
	return nil
}

func runStoryList(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()
	resp, err := client.StoryList(ctx)
	if err != nil {
		return fmt.Errorf("listing stories: %w", err)
	}
	printOutput(resp, func(v any) string {
		r := v.(*aweb.StoryListResponse)
		if len(r.Stories) == 0 {
			return "No stories found.\n"
		}
		var sb strings.Builder
		for _, s := range r.Stories {
			epic := "no epic"
			if s.EpicID != nil && *s.EpicID != "" {
				epic = "epic " + *s.EpicID
			}
			sb.WriteString(fmt.Sprintf("◇ %s [%s] %s (%s)\n", s.StoryID, strings.ToUpper(s.Status), s.Title, epic))
		}
		return sb.String()
	})
	return nil
}

func runStoryCreate(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()
	req := &aweb.StoryCreateRequest{Title: strings.Join(args, " ")}
	req.EpicID, _ = cmd.Flags().GetString("epic")
	story, err := client.StoryCreate(ctx, req)
	if err != nil {
		return fmt.Errorf("creating story: %w", err)
	}
	printOutput(story, func(v any) string {
		s := v.(*aweb.Story)
		return fmt.Sprintf("Created story %s — %s\n", s.StoryID, s.Title)
	})
	return nil
}
