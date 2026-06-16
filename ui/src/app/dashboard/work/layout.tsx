import type { ReactNode } from "react";

import { AssigneeDirectoryProvider } from "@/components/work/assignee-directory";

// Provides the assignee directory to the board and issue-detail routes.
export default function WorkLayout({ children }: { children: ReactNode }) {
  return <AssigneeDirectoryProvider>{children}</AssigneeDirectoryProvider>;
}
