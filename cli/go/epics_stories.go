package aweb

import "context"

// Epic and Story are the organizing levels above Issue.
type Epic struct {
	EpicID    string `json:"epic_id"`
	TeamID    string `json:"team_id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type Story struct {
	StoryID   string  `json:"story_id"`
	EpicID    *string `json:"epic_id"`
	TeamID    string  `json:"team_id"`
	Title     string  `json:"title"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type EpicListResponse struct {
	TeamID string `json:"team_id"`
	Epics  []Epic `json:"epics"`
}

type StoryListResponse struct {
	TeamID  string  `json:"team_id"`
	Stories []Story `json:"stories"`
}

type EpicCreateRequest struct {
	Title  string `json:"title"`
	Status string `json:"status,omitempty"`
}

type StoryCreateRequest struct {
	Title  string `json:"title"`
	Status string `json:"status,omitempty"`
	EpicID string `json:"epic_id,omitempty"`
}

func (c *Client) EpicList(ctx context.Context) (*EpicListResponse, error) {
	var out EpicListResponse
	if err := c.Get(ctx, "/v1/epics", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) EpicCreate(ctx context.Context, req *EpicCreateRequest) (*Epic, error) {
	var out Epic
	if err := c.Post(ctx, "/v1/epics", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) StoryList(ctx context.Context) (*StoryListResponse, error) {
	var out StoryListResponse
	if err := c.Get(ctx, "/v1/stories", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) StoryCreate(ctx context.Context, req *StoryCreateRequest) (*Story, error) {
	var out Story
	if err := c.Post(ctx, "/v1/stories", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
