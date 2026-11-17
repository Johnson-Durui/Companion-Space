import type { components } from "@companion-space/api-client/schema";
import { apiClient as client, apiData as result } from "./api/transport";

export type ClassroomSnapshot = components["schemas"]["ClassroomSnapshot"];
export type Flashcard = components["schemas"]["FlashcardRecord"];
export type ClassroomEvent = components["schemas"]["ClassroomEventRequest"];
type CardStatus = "proposed" | "active" | "due";
type Rating = components["schemas"]["FlashcardRatingRequest"]["rating"];

export async function getClassroom(sessionId: string, signal?: AbortSignal) {
  const response = await client().GET("/api/v1/sessions/{session_id}/classroom", { params: { path: { session_id: sessionId } }, signal });
  return response.response.status === 404 ? null : result(response, "无法恢复互动课堂");
}

export async function startClassroom(sessionId: string, topic: string) {
  return result(await client().POST("/api/v1/sessions/{session_id}/classroom/start", {
    params: { path: { session_id: sessionId } },
    body: { topic },
  }), "无法开启互动课堂");
}

export async function sendClassroomEvent(sessionId: string, event: ClassroomEvent) {
  return result(await client().POST("/api/v1/sessions/{session_id}/classroom/events", {
    params: { path: { session_id: sessionId } },
    body: event,
  }), "无法更新课堂板书");
}

export async function proposeFlashcards(sessionId: string) {
  return result(await client().POST("/api/v1/sessions/{session_id}/classroom/flashcards", {
    params: { path: { session_id: sessionId } },
  }), "无法提炼复习闪卡").items;
}

export async function listFlashcards(spaceId: string, status: CardStatus, signal?: AbortSignal) {
  return result(await client().GET("/api/v1/spaces/{space_id}/classroom/flashcards", {
    params: { path: { space_id: spaceId }, query: { status_filter: status } },
    signal,
  }), "无法读取复习闪卡").items.filter((card) => card.space_id === spaceId);
}

export async function confirmFlashcard(spaceId: string, id: string) {
  return result(await client().POST("/api/v1/spaces/{space_id}/classroom/flashcards/{card_id}/confirm", {
    params: { path: { space_id: spaceId, card_id: id } },
  }), "无法确认复习闪卡");
}

export async function rateFlashcard(spaceId: string, id: string, rating: Rating) {
  return result(await client().POST("/api/v1/spaces/{space_id}/classroom/flashcards/{card_id}/rate", {
    params: { path: { space_id: spaceId, card_id: id } },
    body: { rating },
  }), "无法记录复习结果");
}
