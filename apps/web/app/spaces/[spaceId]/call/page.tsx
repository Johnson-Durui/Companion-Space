import { RealtimeCallShell } from "@/components/realtime/realtime-call-shell";
import { ErrorCallout } from "@/components/ui";

interface SpaceCallPageProps {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}

export default async function SpaceCallPage({ params, searchParams }: SpaceCallPageProps) {
  const [{ spaceId }, query] = await Promise.all([params, searchParams]);
  const rawSessionId = Array.isArray(query.session) ? query.session[0] : query.session;
  const initialSessionId = rawSessionId?.trim() || null;

  if (!spaceId) {
    return <ErrorCallout message="路由中缺少 spaceId，无法创建有空间边界的会话。" />;
  }

  return <RealtimeCallShell initialSessionId={initialSessionId} spaceId={spaceId} />;
}
