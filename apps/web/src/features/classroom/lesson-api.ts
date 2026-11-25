import { browserApiFetch } from "@companion-space/api-client";
import { api, bodyOf, ensureOK } from "../../app/api";

export function fetchLesson(lesson_id: string) {
  return api.GET("/api/v2/lessons/{lesson_id}", { params: { path: { lesson_id } } }).then(bodyOf);
}

export type LessonView = Awaited<ReturnType<typeof fetchLesson>>;

export async function resumeLesson(lesson_id: string): Promise<LessonView> {
  const response = await browserApiFetch(`/api/v2/lessons/${encodeURIComponent(lesson_id)}/resume`, {
    method: "POST",
  });
  const body = await response.json().catch(() => undefined);
  ensureOK(response, body);
  return body as LessonView;
}

export function fetchLessonRecapSummary(lesson_id: string) {
  return api.GET("/api/v2/lessons/{lesson_id}/recap-summary", { params: { path: { lesson_id } } }).then(bodyOf);
}

export function fetchLessonEvents(lesson_id: string, after = 0) {
  return api.GET("/api/v2/lessons/{lesson_id}/events", { params: { path: { lesson_id }, query: { after } } }).then(bodyOf);
}

export function preparePlanItem(plan_item_id: string) {
  return api.POST("/api/v2/plan-items/{plan_item_id}/prepare", { params: { path: { plan_item_id } } }).then(bodyOf);
}

export function fetchPlanItemPrepareStatus(plan_item_id: string) {
  return api.GET("/api/v2/plan-items/{plan_item_id}/prepare-status", { params: { path: { plan_item_id } } }).then(bodyOf);
}

export function createPointPlanItem(course_id: string, kp_id: string) {
  return api.POST("/api/v2/courses/{course_id}/point-plan-items", {
    params: { path: { course_id } },
    body: { kp_id },
  }).then(bodyOf);
}

export function openPlanItemLesson(plan_item_id: string) {
  return api.POST("/api/v2/plan-items/{plan_item_id}/lesson", { params: { path: { plan_item_id } } }).then(bodyOf);
}

export async function openLessonSocket(lesson_id: string, options?: { takeover?: boolean }) {
  const { ticket } = bodyOf(await api.POST("/api/v2/lessons/{lesson_id}/ticket", { params: { path: { lesson_id } } }));
  const url = new URL(`/api/v2/lessons/${encodeURIComponent(lesson_id)}/live`, window.location.href);
  if (options?.takeover) url.searchParams.set("takeover", "1");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["companion-v1", `ticket.${ticket}`]);
  socket.binaryType = "arraybuffer";
  return socket;
}
