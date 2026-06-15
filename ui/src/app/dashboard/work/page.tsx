import { WorkBoard } from "@/components/work/work-board";

/**
 * Work view: Kanban board + grouped list over the Epic -> Story -> Issue
 * hierarchy, with assignee/status filtering. Mounted inside the authenticated
 * dashboard shell (auth guard + team context live in the dashboard layout).
 */
export default function WorkPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Work</h1>
      <WorkBoard />
    </div>
  );
}
