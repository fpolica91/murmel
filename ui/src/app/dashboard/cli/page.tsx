import { CliSetup } from "@/components/cli/cli-setup";

/**
 * "Connect the CLI" — install + authenticate the `aw` CLI and bind a workspace
 * to the active team. Mounted inside the authenticated dashboard shell (auth
 * guard + team context live in the dashboard layout).
 */
export default function CliPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Connect the CLI</h1>
      <CliSetup />
    </div>
  );
}
