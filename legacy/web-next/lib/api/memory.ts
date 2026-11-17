import type { MemoryItem, MemoryItemWire } from "@/lib/types";
import { ApiError, contractError, expectArrayField, request, scopedItemKey } from "./transport";

type MemoryUpdateInput =
  | Partial<Pick<MemoryItemWire, "content" | "status" | "sensitive">>
  | Partial<MemoryItem>;

const memoryItemsById = new Map<string, MemoryItemWire>();

export function toMemoryView(item: MemoryItemWire): MemoryItem {
  memoryItemsById.set(scopedItemKey(item.space_id, item.id), item);
  return {
    id: item.id,
    space_id: item.space_id,
    content: item.content,
    confirmed: item.status === "confirmed",
    sensitivity: item.sensitive ? "sensitive" : "normal",
    source_session_id: item.source_session_id ?? null,
    created_at: item.created_at,
  };
}

async function loadMemoryItemsWire(spaceId: string): Promise<MemoryItemWire[]> {
  const payload = await request<unknown>(`/api/v1/memory/${spaceId}`);
  const items = expectArrayField<MemoryItemWire>(payload, "items", "记忆列表接口");
  for (const item of items) {
    if (item.space_id !== spaceId) {
      throw contractError("记忆接口返回了其他空间的数据，已拒绝缓存", item);
    }
    memoryItemsById.set(scopedItemKey(spaceId, item.id), item);
  }
  return items;
}

async function resolveMemoryItem(memoryId: string, spaceId: string): Promise<MemoryItemWire> {
  const cached = memoryItemsById.get(scopedItemKey(spaceId, memoryId));
  if (cached && cached.space_id === spaceId) {
    return cached;
  }
  const item = (await loadMemoryItemsWire(spaceId)).find((candidate) => candidate.id === memoryId);
  if (item) {
    return item;
  }
  throw new ApiError("当前空间中不存在该记忆项", 404, {
    memory_id: memoryId,
    space_id: spaceId,
  });
}

export async function listMemoryItems(spaceId: string) {
  return (await loadMemoryItemsWire(spaceId)).map(toMemoryView);
}

export async function confirmMemoryItem(memoryId: string, spaceId: string) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const payload = await request<MemoryItemWire>(
    `/api/v1/memory/${current.space_id}/${memoryId}/confirm`,
    {
      method: "POST",
    },
  );
  return toMemoryView(payload);
}

export async function updateMemoryItem(
  memoryId: string,
  input: MemoryUpdateInput,
  spaceId: string,
) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const nextStatus =
    "status" in input && input.status
      ? input.status
      : "confirmed" in input && input.confirmed !== undefined
        ? input.confirmed
          ? "confirmed"
          : "candidate"
        : current.status;
  const nextSensitive =
    "sensitive" in input && input.sensitive !== undefined
      ? input.sensitive
      : "sensitivity" in input && input.sensitivity !== undefined
        ? input.sensitivity === "sensitive"
        : current.sensitive;
  const payload = await request<MemoryItemWire>(
    `/api/v1/memory/${current.space_id}/${memoryId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: input.content ?? current.content,
        status: nextStatus,
        sensitive: nextSensitive,
      }),
    },
  );
  return toMemoryView(payload);
}

export async function deleteMemoryItem(memoryId: string, spaceId: string) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const result = await request<null>(`/api/v1/memory/${current.space_id}/${memoryId}`, {
    method: "DELETE",
  });
  memoryItemsById.delete(scopedItemKey(spaceId, memoryId));
  return result;
}
