"use client";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type IssueStatus,
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
 * Filter controls shared by the board and list views. Filtering by
 * assignee (type + id) and status maps 1:1 onto the `GET /v1/issues`
 * query parameters.
 */
export function WorkFilters({
  value,
  onChange,
}: {
  value: WorkFilterState;
  onChange: (next: WorkFilterState) => void;
}) {
  function patch(partial: Partial<WorkFilterState>) {
    onChange({ ...value, ...partial });
  }

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
