import { EpicsOverview } from "@/components/epics/epics-overview";

/**
 * Epics view: master/detail epic burndown. The left column lists epics with a
 * status badge + done/total rollup; selecting one shows its child issues on the
 * right. Read-only over the existing `/v1/epics` + `/v1/issues` endpoints.
 * Mounted inside the authenticated dashboard shell (auth guard + team context
 * live in the dashboard layout).
 */
export default function EpicsPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Epics</h1>
      <EpicsOverview />
    </div>
  );
}
