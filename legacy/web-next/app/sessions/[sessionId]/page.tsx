import { SessionReview } from "@/components/session-review";

export default async function SessionDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <SessionReview sessionId={sessionId} />;
}
