import { MemoryPanel } from "@/components/memory-panel";

interface MemoryPageProps {
  searchParams: Promise<{ spaceId?: string | string[] }>;
}

export default async function MemoryPage({ searchParams }: MemoryPageProps) {
  const params = await searchParams;
  const initialSpaceId =
    typeof params.spaceId === "string" ? params.spaceId : undefined;
  return <MemoryPanel initialSpaceId={initialSpaceId} />;
}
