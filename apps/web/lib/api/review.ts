import type { ReviewItem, ReviewItemWire, ReviewStatus } from "@/lib/types";
import { ApiError, contractError, expectArrayField, request, scopedItemKey } from "./transport";

type ReviewUpdateInput =
  | Partial<Pick<ReviewItemWire, "prompt" | "answer" | "due_at" | "status">>
  | Partial<ReviewItem>;

const reviewItemsById = new Map<string, ReviewItemWire>();

export function toReviewView(item: ReviewItemWire): ReviewItem {
  reviewItemsById.set(scopedItemKey(item.space_id, item.id), item);
  return {
    id: item.id,
    space_id: item.space_id,
    prompt: item.prompt,
    answer: item.answer,
    due_at: item.due_at,
    status: item.status === "completed" ? "done" : "pending",
    source_session_id: item.source_session_id ?? null,
    created_at: item.created_at,
  };
}

function toReviewStatus(value: string | null | undefined, current: ReviewStatus): ReviewStatus {
  if (value === undefined || value === null) {
    return current;
  }
  if (value === "done" || value === "completed") {
    return "completed";
  }
  if (value === "pending") {
    return "pending";
  }
  throw new ApiError(`不支持的复习状态：${value}`, 400, { status: value });
}

async function loadReviewItemsWire(spaceId: string): Promise<ReviewItemWire[]> {
  const payload = await request<unknown>(`/api/v1/review-items/${spaceId}`);
  const items = expectArrayField<ReviewItemWire>(payload, "items", "复习项列表接口");
  for (const item of items) {
    if (item.space_id !== spaceId) {
      throw contractError("复习项接口返回了其他空间的数据，已拒绝缓存", item);
    }
    reviewItemsById.set(scopedItemKey(spaceId, item.id), item);
  }
  return items;
}

async function resolveReviewItem(reviewId: string, spaceId: string): Promise<ReviewItemWire> {
  const cached = reviewItemsById.get(scopedItemKey(spaceId, reviewId));
  if (cached && cached.space_id === spaceId) {
    return cached;
  }
  const item = (await loadReviewItemsWire(spaceId)).find((candidate) => candidate.id === reviewId);
  if (item) {
    return item;
  }
  throw new ApiError("当前空间中不存在该复习项", 404, {
    review_id: reviewId,
    space_id: spaceId,
  });
}

export async function listReviewItems(spaceId: string) {
  return (await loadReviewItemsWire(spaceId)).map(toReviewView);
}

export async function updateReviewItem(
  reviewId: string,
  input: ReviewUpdateInput,
  spaceId: string,
) {
  const current = await resolveReviewItem(reviewId, spaceId);
  const requestedStatus = "status" in input ? input.status : undefined;
  const status = toReviewStatus(requestedStatus, current.status);
  const payload = await request<ReviewItemWire>(
    `/api/v1/review-items/${current.space_id}/${reviewId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt ?? current.prompt,
        answer: input.answer ?? current.answer,
        due_at: input.due_at === undefined ? current.due_at : input.due_at,
        status,
      }),
    },
  );
  return toReviewView(payload);
}

export async function deleteReviewItem(reviewId: string, spaceId: string) {
  const current = await resolveReviewItem(reviewId, spaceId);
  const result = await request<null>(
    `/api/v1/review-items/${current.space_id}/${reviewId}`,
    { method: "DELETE" },
  );
  reviewItemsById.delete(scopedItemKey(spaceId, reviewId));
  return result;
}
