import { ReviewItemsPanel } from "@/components/review-items-panel";

interface ReviewItemsPageProps {
  searchParams: Promise<{ spaceId?: string | string[] }>;
}

export default async function ReviewItemsPage({ searchParams }: ReviewItemsPageProps) {
  const params = await searchParams;
  const initialSpaceId =
    typeof params.spaceId === "string" ? params.spaceId : undefined;
  return <ReviewItemsPanel initialSpaceId={initialSpaceId} />;
}
