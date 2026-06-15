package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	aweb "github.com/awebai/aw"
	"github.com/spf13/cobra"
)

// `aw issue` — terminal access to the Epic -> Story -> Issue work hierarchy,
// complementing the issues_* MCP tools. Works with both team-certificate and
// `aw login` (bearer) auth.

var issueCmd = &cobra.Command{
	Use:   "issue",
	Short: "Manage work-hierarchy issues",
}

var issueListCmd = &cobra.Command{
	Use:   "list",
	Short: "List issues in the current team",
	RunE:  runIssueList,
}

var issueCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create an issue",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runIssueCreate,
}

var issueShowCmd = &cobra.Command{
	Use:   "show <issue-id>",
	Short: "Show an issue and its comments",
	Args:  cobra.ExactArgs(1),
	RunE:  runIssueShow,
}

var issueCommentCmd = &cobra.Command{
	Use:   "comment <issue-id> <body>",
	Short: "Post a comment to an issue's thread",
	Args:  cobra.MinimumNArgs(2),
	RunE:  runIssueComment,
}

func init() {
	issueListCmd.Flags().String("status", "", "Filter by status (todo, in_progress, in_review, done)")
	issueListCmd.Flags().String("assignee-type", "", "Filter by assignee type (human, agent)")
	issueListCmd.Flags().String("assignee", "", "Filter by assignee id")

	issueCreateCmd.Flags().String("description", "", "Issue description")
	issueCreateCmd.Flags().String("epic", "", "Parent epic id")
	issueCreateCmd.Flags().String("story", "", "Parent story id")
	issueCreateCmd.Flags().String("assignee-type", "", "Assignee type (human, agent)")
	issueCreateCmd.Flags().String("assignee", "", "Assignee id")

	issueCmd.AddCommand(issueListCmd, issueCreateCmd, issueShowCmd, issueCommentCmd)
	rootCmd.AddCommand(issueCmd)
}

func issueClient() (*aweb.Client, context.Context, context.CancelFunc, error) {
	client, err := resolveClient()
	if err != nil {
		return nil, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	return client, ctx, cancel, nil
}

func runIssueList(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()

	params := aweb.IssueListParams{}
	params.Status, _ = cmd.Flags().GetString("status")
	params.AssigneeType, _ = cmd.Flags().GetString("assignee-type")
	params.AssigneeID, _ = cmd.Flags().GetString("assignee")

	resp, err := client.IssueList(ctx, params)
	if err != nil {
		return fmt.Errorf("listing issues: %w", err)
	}
	printOutput(resp, func(v any) string {
		r := v.(*aweb.IssueListResponse)
		if len(r.Issues) == 0 {
			return "No issues found.\n"
		}
		var sb strings.Builder
		for _, it := range r.Issues {
			sb.WriteString(formatIssueLine(it))
			sb.WriteString("\n")
		}
		return sb.String()
	})
	return nil
}

func runIssueCreate(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()

	req := &aweb.IssueCreateRequest{Title: strings.Join(args, " ")}
	req.Description, _ = cmd.Flags().GetString("description")
	req.EpicID, _ = cmd.Flags().GetString("epic")
	req.StoryID, _ = cmd.Flags().GetString("story")
	req.AssigneeType, _ = cmd.Flags().GetString("assignee-type")
	req.AssigneeID, _ = cmd.Flags().GetString("assignee")

	issue, err := client.IssueCreate(ctx, req)
	if err != nil {
		return fmt.Errorf("creating issue: %w", err)
	}
	printOutput(issue, func(v any) string {
		it := v.(*aweb.Issue)
		return fmt.Sprintf("Created %s — %s\n", it.IssueID, it.Title)
	})
	return nil
}

func runIssueShow(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()

	issue, err := client.IssueGet(ctx, args[0])
	if err != nil {
		return fmt.Errorf("getting issue: %w", err)
	}
	comments, err := client.IssueComments(ctx, args[0])
	if err != nil {
		return fmt.Errorf("getting comments: %w", err)
	}
	out := struct {
		*aweb.Issue
		Comments []aweb.IssueComment `json:"comments"`
	}{issue, comments.Comments}
	printOutput(out, func(v any) string {
		o := v.(struct {
			*aweb.Issue
			Comments []aweb.IssueComment `json:"comments"`
		})
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("%s — %s   [%s]\n", o.IssueID, o.Title, strings.ToUpper(o.Status)))
		sb.WriteString(fmt.Sprintf("Assignee: %s\n", issueAssignee(o.Issue)))
		if o.Description != "" {
			sb.WriteString(fmt.Sprintf("\nDESCRIPTION\n%s\n", o.Description))
		}
		sb.WriteString("\nCOMMENTS\n")
		if len(o.Comments) == 0 {
			sb.WriteString("No comments.\n")
		}
		for _, c := range o.Comments {
			sb.WriteString(fmt.Sprintf("[%s] %s:\n  %s\n", formatDate(c.CreatedAt), c.Author, c.Body))
		}
		return sb.String()
	})
	return nil
}

func runIssueComment(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := issueClient()
	if err != nil {
		return err
	}
	defer cancel()

	body := strings.Join(args[1:], " ")
	comment, err := client.IssueCommentAdd(ctx, args[0], body)
	if err != nil {
		return fmt.Errorf("posting comment: %w", err)
	}
	printOutput(comment, func(v any) string {
		c := v.(*aweb.IssueComment)
		return fmt.Sprintf("Commented on %s as %s.\n", c.IssueID, c.Author)
	})
	return nil
}

func formatIssueLine(it aweb.Issue) string {
	comments := ""
	if it.CommentCount > 0 {
		comments = fmt.Sprintf(" 💬%d", it.CommentCount)
	}
	return fmt.Sprintf("○ %s [%s] %s — %s%s",
		it.IssueID, strings.ToUpper(it.Status), issueAssignee(&it), it.Title, comments)
}

func issueAssignee(it *aweb.Issue) string {
	if it.AssigneeID != nil && *it.AssigneeID != "" {
		t := ""
		if it.AssigneeType != nil {
			t = *it.AssigneeType + ":"
		}
		return t + *it.AssigneeID
	}
	return "unassigned"
}
