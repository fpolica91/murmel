"use client";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type Epic,
  type IssueStatus,
  type Story,
} from "@/lib/api/types";
import styles from "./work.module.css";

export interface WorkFilterState {
  status?: IssueStatus;
  assignee_type?: AssigneeType;
  assignee_id?: string;
  epic_id?: string;
  story_id?: string;
}

/**
 * Filter controls shared by the board and list views. Status, assignee
 * (type + id), epic, and story all map 1:1 onto the `GET /v1/issues` query
 * parameters. Story options narrow to the selected epic, and changing the
 * epic clears any story filter that no longer applies.
 */
export function WorkFilters({
  value,
  onChange,
  epics,
  stories,
}: {
  value: WorkFilterState;
  onChange: (next: WorkFilterState) => void;
  epics: Epic[];
  stories: Story[];
}) {
  function patch(partial: Partial<WorkFilterState>) {
    onChange({ ...value, ...partial });
  }

  // When an epic is selected, only its stories are offered.
  const storyOptions = value.epic_id
    ? stories.filter((s) => s.epic_id === value.epic_id)
    : stories;

  return (
    <>
      <select
        className={styles.filterSelect}
        aria-label="Filter by status"
        value={value.status ?? ""}
        onChange={(e) =>
          patch({ status: (e.target.value || undefined) as IssueStatus | undefined })
        }
      >
        <option value="">All statuses</option>
        {ISSUE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {ISSUE_STATUS_LABELS[s]}
          </option>
        ))}
      </select>

      <select
        className={styles.filterSelect}
        aria-label="Filter by epic"
        value={value.epic_id ?? ""}
        onChange={(e) =>
          // Changing the epic resets the story filter (its options change).
          patch({ epic_id: e.target.value || undefined, story_id: undefined })
        }
      >
        <option value="">All epics</option>
        {epics.map((epic) => (
          <option key={epic.epic_id} value={epic.epic_id}>
            {epic.title}
          </option>
        ))}
      </select>

      <select
        className={styles.filterSelect}
        aria-label="Filter by story"
        value={value.story_id ?? ""}
        onChange={(e) => patch({ story_id: e.target.value || undefined })}
        disabled={storyOptions.length === 0}
      >
        <option value="">All stories</option>
        {storyOptions.map((story) => (
          <option key={story.story_id} value={story.story_id}>
            {story.title}
          </option>
        ))}
      </select>

      <select
        className={styles.filterSelect}
        aria-label="Filter by assignee type"
        value={value.assignee_type ?? ""}
        onChange={(e) =>
          patch({
            assignee_type: (e.target.value || undefined) as
              | AssigneeType
              | undefined,
          })
        }
      >
        <option value="">Any assignee type</option>
        <option value="human">Human</option>
        <option value="agent">Agent</option>
      </select>

      <input
        className={styles.filterInput}
        type="text"
        placeholder="Assignee id…"
        aria-label="Filter by assignee id"
        value={value.assignee_id ?? ""}
        onChange={(e) => patch({ assignee_id: e.target.value || undefined })}
      />
    </>
  );
}
