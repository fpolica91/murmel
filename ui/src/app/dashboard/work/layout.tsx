import type { ReactNode } from "react";

import { AssigneeDirectoryProvider } from "@/components/work/assignee-directory";

/**
 * Wraps every work route (the board and the issue detail) with the assignee
 * directory so cards, rows, and the detail sidebar all resolve an issue's
 * `assignee_id` to a display name (handling both the alias and the JWT-subject
 * form that MCP-claimed issues store).
 */
export default function WorkLayout({ children }: { children: ReactNode }) {
  return <AssigneeDirectoryProvider>{children}</AssigneeDirectoryProvider>;
}
