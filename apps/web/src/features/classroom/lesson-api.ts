import { api, bodyOf } from "../../app/api";

export function fetchLesson(lesson_id: string) {
  return api.GET("/api/v2/lessons/{lesson_id}", { params: { path: { lesson_id } } }).then(bodyOf);
}

export function fetchLessonEvents(lesson_id: string, after = 0) {
  return api.GET("/api/v2/lessons/{lesson_id}/events", { params: { path: { lesson_id }, query: { after } } }).then(bodyOf);
}

export async function openLessonSocket(lesson_id: string) {
  const { ticket } = bodyOf(await api.POST("/api/v2/lessons/{lesson_id}/ticket", { params: { path: { lesson_id } } }));
  const url = new URL(`/api/v2/lessons/${encodeURIComponent(lesson_id)}/live`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["companion-v1", `ticket.${ticket}`]);
  socket.binaryType = "arraybuffer";
  return socket;
}
