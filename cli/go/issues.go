package aweb

import (
	"context"
	"net/url"
)

// Issue is a work-hierarchy issue (the floor of Epic -> Story -> Issue).
type Issue struct {
	IssueID      string  `json:"issue_id"`
	TeamID       string  `json:"team_id"`
	EpicID       *string `json:"epic_id"`
	StoryID      *string `json:"story_id"`
	Title        string  `json:"title"`
	Description  string  `json:"description"`
	Status       string  `json:"status"`
	AssigneeType *string `json:"assignee_type"`
	AssigneeID   *string `json:"assignee_id"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
	CommentCount int     `json:"comment_count"`
}

// IssueListResponse is the envelope returned by GET /v1/issues.
type IssueListResponse struct {
	TeamID string  `json:"team_id"`
	Issues []Issue `json:"issues"`
}

// IssueListParams are the optional filters for listing issues.
type IssueListParams struct {
	Status       string
	AssigneeType string
	AssigneeID   string
}

// IssueCreateRequest is the POST /v1/issues body.
type IssueCreateRequest struct {
	Title        string `json:"title"`
	Description  string `json:"description,omitempty"`
	Status       string `json:"status,omitempty"`
	EpicID       string `json:"epic_id,omitempty"`
	StoryID      string `json:"story_id,omitempty"`
	AssigneeType string `json:"assignee_type,omitempty"`
	AssigneeID   string `json:"assignee_id,omitempty"`
}

// IssueComment is one entry in an issue's activity thread.
type IssueComment struct {
	CommentID string `json:"comment_id"`
	IssueID   string `json:"issue_id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// IssueCommentListResponse is the envelope returned by GET .../comments.
type IssueCommentListResponse struct {
	IssueID  string         `json:"issue_id"`
	Comments []IssueComment `json:"comments"`
}

// IssueList lists issues in the authenticated team, with optional filters.
func (c *Client) IssueList(ctx context.Context, params IssueListParams) (*IssueListResponse, error) {
	path := "/v1/issues"
	q := url.Values{}
	if params.Status != "" {
		q.Set("status", params.Status)
	}
	if params.AssigneeType != "" {
		q.Set("assignee_type", params.AssigneeType)
	}
	if params.AssigneeID != "" {
		q.Set("assignee_id", params.AssigneeID)
	}
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out IssueListResponse
	if err := c.Get(ctx, path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssueCreate creates an issue.
func (c *Client) IssueCreate(ctx context.Context, req *IssueCreateRequest) (*Issue, error) {
	var out Issue
	if err := c.Post(ctx, "/v1/issues", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssueUpdateRequest patches an issue. Only set fields are sent.
type IssueUpdateRequest struct {
	Status       string `json:"status,omitempty"`
	AssigneeType string `json:"assignee_type,omitempty"`
	AssigneeID   string `json:"assignee_id,omitempty"`
}

// IssueUpdate patches an issue (status / assignee).
func (c *Client) IssueUpdate(ctx context.Context, issueID string, req *IssueUpdateRequest) (*Issue, error) {
	var out Issue
	if err := c.Patch(ctx, "/v1/issues/"+urlPathEscape(issueID), req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssueGet fetches a single issue.
func (c *Client) IssueGet(ctx context.Context, issueID string) (*Issue, error) {
	var out Issue
	if err := c.Get(ctx, "/v1/issues/"+urlPathEscape(issueID), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssueCommentAdd posts a comment to an issue's thread.
func (c *Client) IssueCommentAdd(ctx context.Context, issueID, body string) (*IssueComment, error) {
	var out IssueComment
	reqBody := map[string]string{"body": body}
	if err := c.Post(ctx, "/v1/issues/"+urlPathEscape(issueID)+"/comments", reqBody, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssueComments lists an issue's comments oldest-first.
func (c *Client) IssueComments(ctx context.Context, issueID string) (*IssueCommentListResponse, error) {
	var out IssueCommentListResponse
	if err := c.Get(ctx, "/v1/issues/"+urlPathEscape(issueID)+"/comments", &out); err != nil {
		return nil, err
	}
	return &out, nil
}
