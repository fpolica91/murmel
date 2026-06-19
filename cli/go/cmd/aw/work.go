package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	aweb "github.com/awebai/aw"
	"github.com/awebai/aw/awconfig"
	"github.com/spf13/cobra"
)

var workCmd = &cobra.Command{
	Use:   "work",
	Short: "Discover coordination-aware work",
}

var workReadyCmd = &cobra.Command{
	Use:   "ready",
	Short: "List unassigned todo issues that are not already claimed by other workspaces",
	RunE:  runWorkReady,
}

var workActiveCmd = &cobra.Command{
	Use:   "active",
	Short: "List in-progress issues across the team",
	RunE:  runWorkActive,
}

var workBlockedCmd = &cobra.Command{
	Use:   "blocked",
	Short: "Blocked work",
	RunE:  runWorkBlocked,
}

type workListItem struct {
	IssueID  string  `json:"issue_id"`
	Title    string  `json:"title"`
	Status   string  `json:"status,omitempty"`
	Assignee *string `json:"assignee,omitempty"`
}

type workListOutput struct {
	Kind  string         `json:"kind"`
	Items []workListItem `json:"items"`
}

func init() {
	workCmd.AddCommand(workReadyCmd)
	workCmd.AddCommand(workActiveCmd)
	workCmd.AddCommand(workBlockedCmd)
	rootCmd.AddCommand(workCmd)
}

func runWorkReady(cmd *cobra.Command, args []string) error {
	client, sel, err := resolveClientSelection()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	claimsResp, err := client.ClaimsList(ctx, "", 200)
	if err != nil {
		return err
	}
	claimedByOthers := map[string]bool{}
	for _, claim := range claimsResp.Claims {
		if claim.WorkspaceID != sel.WorkspaceID {
			claimedByOthers[claim.BeadID] = true
		}
	}

	resp, err := client.WorkReady(ctx)
	if err != nil {
		return err
	}

	items := make([]workListItem, 0, len(resp.Issues))
	for _, issue := range resp.Issues {
		// The server already returns todo + unassigned + dependency-unblocked
		// issues. We still drop issues claimed by *other* local workspaces,
		// which the server cannot know about.
		if claimedByOthers[issue.IssueID] {
			continue
		}
		items = append(items, workListItem{
			IssueID: issue.IssueID,
			Title:   issue.Title,
			Status:  issue.Status,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].IssueID < items[j].IssueID
	})

	printOutput(workListOutput{Kind: "ready", Items: items}, formatWorkList)
	return nil
}

func runWorkActive(cmd *cobra.Command, args []string) error {
	client, _, err := resolveClientSelection()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	resp, err := client.IssueList(ctx, aweb.IssueListParams{Status: "in_progress"})
	if err != nil {
		return err
	}

	items := make([]workListItem, 0, len(resp.Issues))
	for _, issue := range resp.Issues {
		items = append(items, workListItem{
			IssueID:  issue.IssueID,
			Title:    issue.Title,
			Status:   issue.Status,
			Assignee: workIssueAssignee(issue),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].IssueID < items[j].IssueID
	})

	printOutput(workListOutput{Kind: "active", Items: items}, formatWorkList)
	return nil
}

func runWorkBlocked(cmd *cobra.Command, args []string) error {
	client, _, err := resolveClientSelection()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	resp, err := client.WorkBlocked(ctx)
	if err != nil {
		return err
	}

	items := make([]workListItem, 0, len(resp.Issues))
	for _, issue := range resp.Issues {
		items = append(items, workListItem{
			IssueID:  issue.IssueID,
			Title:    issue.Title,
			Status:   issue.Status,
			Assignee: workIssueAssignee(issue),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].IssueID < items[j].IssueID
	})

	printOutput(workListOutput{Kind: "blocked", Items: items}, formatWorkList)
	return nil
}

func issueIsAssigned(issue aweb.Issue) bool {
	return issue.AssigneeID != nil && strings.TrimSpace(*issue.AssigneeID) != ""
}

// workIssueAssignee returns a "type:id" assignee label, or nil when unassigned.
func workIssueAssignee(issue aweb.Issue) *string {
	if !issueIsAssigned(issue) {
		return nil
	}
	label := strings.TrimSpace(*issue.AssigneeID)
	if issue.AssigneeType != nil && strings.TrimSpace(*issue.AssigneeType) != "" {
		label = strings.TrimSpace(*issue.AssigneeType) + ":" + label
	}
	return &label
}

func formatWorkList(v any) string {
	out := v.(workListOutput)
	if len(out.Items) == 0 {
		switch out.Kind {
		case "ready":
			return "No ready work.\n"
		case "active":
			return "No active work.\n"
		case "blocked":
			return "No blocked work.\n"
		default:
			return "No work items.\n"
		}
	}

	title := map[string]string{
		"ready":   "Ready work",
		"active":  "Active work",
		"blocked": "Blocked work",
	}[out.Kind]
	if title == "" {
		title = "Work"
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s (%d):\n\n", title, len(out.Items)))
	for _, item := range out.Items {
		assignee := strings.TrimSpace(valueOrEmpty(item.Assignee))
		if assignee == "" {
			assignee = "unassigned"
		}
		line := fmt.Sprintf(
			"  %s  [%s]  %s  %s",
			item.IssueID,
			strings.ToUpper(item.Status),
			item.Title,
			assignee,
		)
		sb.WriteString(strings.TrimRight(line, " ") + "\n")
	}
	return sb.String()
}

func valueOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// currentWorkspaceID resolves the active workspace id for the current worktree.
// Retained as a small reusable helper for workspace-scoped CLI filtering.
func currentWorkspaceID(workingDir string, sel *awconfig.Selection) string {
	if state, _, err := awconfig.LoadWorktreeWorkspaceFromDir(workingDir); err == nil {
		if membership, err := workspaceMembershipForSelection(state, sel); err == nil && membership != nil && strings.TrimSpace(membership.WorkspaceID) != "" {
			return strings.TrimSpace(membership.WorkspaceID)
		}
	}
	if sel == nil {
		return ""
	}
	return strings.TrimSpace(sel.WorkspaceID)
}

var _ = currentWorkspaceID
