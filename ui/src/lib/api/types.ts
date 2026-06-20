/**
 * Typed domain models for the aweb work hierarchy (Epic -> Story -> Issue).
 *
 * These mirror the server REST contract under `/v1/epics`, `/v1/stories`, and
 * `/v1/issues`. The `tasks` table stays for compat and is NOT modeled here;
 * issues are the unit of work surfaced by the board / list views.
 */

export type IssueStatus = "todo" | "in_progress" | "in_review" | "done";

/** Ordered columns for the board view. */
export const ISSUE_STATUSES: IssueStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export type AssigneeType = "human" | "agent";

export interface Epic {
  epic_id: string;
  team_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Story {
  story_id: string;
  epic_id: string | null;
  team_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  issue_id: string;
  team_id: string;
  epic_id: string | null;
  story_id: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  assignee_type: AssigneeType | null;
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
  comment_count?: number;
}

/** Query filters accepted by `GET /v1/issues`. */
export interface IssueListFilters {
  status?: IssueStatus;
  assignee_type?: AssigneeType;
  assignee_id?: string;
  epic_id?: string;
  story_id?: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  epic_id?: string | null;
  story_id?: string | null;
  assignee_type?: AssigneeType | null;
  assignee_id?: string | null;
}

export interface Comment {
  comment_id: string;
  issue_id: string;
  author: string;
  body: string;
  created_at: string | null;
}

export interface CommentListResponse {
  issue_id: string;
  comments: Comment[];
}

/** A dependency-graph neighbour of an issue (a blocking or blocked issue). */
export interface IssueDependencyRef {
  issue_id: string;
  title: string;
  status: IssueStatus;
}

/**
 * Dependency neighbours of an issue, returned by
 * `GET/POST/DELETE /v1/issues/{id}/dependencies`. `blocked_by` are the issues
 * THIS one depends on (its blockers); `blocks` are the issues that depend on it.
 */
export interface IssueDependencies {
  issue_id: string;
  blocked_by: IssueDependencyRef[];
  blocks: IssueDependencyRef[];
}

export interface CreateEpicInput {
  title: string;
  status?: string;
}

export interface CreateStoryInput {
  title: string;
  status?: string;
  epic_id?: string | null;
}

export interface UpdateIssueStatusInput {
  status: IssueStatus;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  epic_id?: string | null;
  story_id?: string | null;
  assignee_type?: AssigneeType | null;
  assignee_id?: string | null;
}

/** List envelopes returned by the server (mirrors the tasks-route shape). */
export interface EpicListResponse {
  epics: Epic[];
}

export interface StoryListResponse {
  stories: Story[];
}

export interface IssueListResponse {
  issues: Issue[];
}
