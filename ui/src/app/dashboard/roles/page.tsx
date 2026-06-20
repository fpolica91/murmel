import { RolesManager } from "@/components/roles/roles-manager";

/**
 * Roles view: humans curate the team's coordination-role bundle — the named
 * playbooks agents read via `roles_show`. Mounted inside the authenticated
 * dashboard shell (auth guard + team context live in the dashboard layout).
 */
export default function RolesPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Roles</h1>
      <RolesManager />
    </div>
  );
}
