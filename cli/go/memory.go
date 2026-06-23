package aweb

import (
	"context"
	"net/url"
	"strings"
)

// Memory is a team-scoped knowledge note. The team is derived server-side from
// the authenticated token; it is never set by the client in request bodies.
type Memory struct {
	MemoryID       string   `json:"memory_id"`
	TeamID         string   `json:"team_id"`
	Title          string   `json:"title"`
	BodyMD         string   `json:"body_md"`
	Tags           []string `json:"tags"`
	Project        string   `json:"project"`
	CreatedByAlias string   `json:"created_by_alias"`
	AssigneeAlias  string   `json:"assignee_alias"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

// MemoryListResponse is the envelope returned by GET /v1/memories.
type MemoryListResponse struct {
	Memories []Memory `json:"memories"`
}

// MemoryCreateRequest is the POST /v1/memories body. Team is never included;
// the server derives it from the token.
type MemoryCreateRequest struct {
	Title         string   `json:"title"`
	BodyMD        string   `json:"body_md,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	Project       string   `json:"project,omitempty"`
	AssigneeAlias string   `json:"assignee_alias,omitempty"`
}

// MemoryUpdateRequest patches a memory. Only set fields are sent.
type MemoryUpdateRequest struct {
	Title  *string   `json:"title,omitempty"`
	BodyMD *string   `json:"body_md,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
}

// MemorySearch lists memories in the authenticated team, with optional
// full-text query, tag filter, assignee filter, and result limit. An empty
// query returns the most-recent memories. tags is a comma-separated string
// matching the REST `tag` query param (e.g. "ops,infra").
func (c *Client) MemorySearch(ctx context.Context, q, tags, assignee, project string, limit int) (*MemoryListResponse, error) {
	path := "/v1/memories"
	v := url.Values{}
	if strings.TrimSpace(q) != "" {
		v.Set("q", strings.TrimSpace(q))
	}
	if strings.TrimSpace(tags) != "" {
		v.Set("tag", strings.TrimSpace(tags))
	}
	if strings.TrimSpace(assignee) != "" {
		v.Set("assignee_alias", strings.TrimSpace(assignee))
	}
	if strings.TrimSpace(project) != "" {
		v.Set("project", strings.TrimSpace(project))
	}
	if limit > 0 {
		v.Set("limit", itoa(limit))
	}
	if len(v) > 0 {
		path += "?" + v.Encode()
	}
	var out MemoryListResponse
	if err := c.Get(ctx, path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MemorySave creates a memory. tags is a comma-separated string; assignee, when
// set, marks the memory private to that alias.
func (c *Client) MemorySave(ctx context.Context, title, bodyMd, tags, assignee, project string) (*Memory, error) {
	req := &MemoryCreateRequest{
		Title:         strings.TrimSpace(title),
		BodyMD:        bodyMd,
		Tags:          splitTags(tags),
		Project:       strings.TrimSpace(project),
		AssigneeAlias: strings.TrimSpace(assignee),
	}
	var out Memory
	if err := c.Post(ctx, "/v1/memories", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MemoryGet fetches a single memory by id.
func (c *Client) MemoryGet(ctx context.Context, id string) (*Memory, error) {
	var out Memory
	if err := c.Get(ctx, "/v1/memories/"+urlPathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MemoryUpdate patches a memory. Empty title/bodyMd/tags strings leave the
// corresponding field unchanged (only non-empty values are sent).
func (c *Client) MemoryUpdate(ctx context.Context, id, title, bodyMd, tags string) (*Memory, error) {
	req := &MemoryUpdateRequest{}
	if strings.TrimSpace(title) != "" {
		t := strings.TrimSpace(title)
		req.Title = &t
	}
	if bodyMd != "" {
		b := bodyMd
		req.BodyMD = &b
	}
	if strings.TrimSpace(tags) != "" {
		t := splitTags(tags)
		req.Tags = &t
	}
	var out Memory
	if err := c.Patch(ctx, "/v1/memories/"+urlPathEscape(id), req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MemoryDelete deletes a memory by id.
func (c *Client) MemoryDelete(ctx context.Context, id string) error {
	return c.Delete(ctx, "/v1/memories/"+urlPathEscape(id))
}

// splitTags turns a comma-separated tag string into a trimmed, non-empty slice.
func splitTags(tags string) []string {
	tags = strings.TrimSpace(tags)
	if tags == "" {
		return nil
	}
	parts := strings.Split(tags, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
