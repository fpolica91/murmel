import { IssueDetail } from "@/components/work/issue-detail";

/**
 * Issue-detail route. The issue id comes from the dynamic segment; the detail
 * component fetches the issue (and its parent epic/story) client-side via the
 * typed work API.
 */
export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ issueId: string }>;
}) {
  const { issueId } = await params;
  return <IssueDetail issueId={issueId} />;
}
