import { RealtimeCallShell } from "@/components/realtime/realtime-call-shell";

interface SpaceCallPageProps {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<{ session?: string | string[]; view?: string | string[] }>;
}

export default async function SpaceCallPage({ params, searchParams }: SpaceCallPageProps) {
  const [{ spaceId }, query] = await Promise.all([params, searchParams]);
  const rawSessionId = Array.isArray(query.session) ? query.session[0] : query.session;
  const initialSessionId = rawSessionId?.trim() || null;

  if (!spaceId) {
    return (
      <div className="error-callout" role="alert">
        路由中缺少 spaceId，无法创建有空间边界的会话。
      </div>
    );
  }

  return <RealtimeCallShell initialSessionId={initialSessionId} spaceId={spaceId} initialImmersive={query.view === "immersive"} />;
}
