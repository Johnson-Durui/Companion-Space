import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import { ApiError, errorCodeOf, publicMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";

export type SolveSessionSummary = components["schemas"]["SolveSessionSummary"];
export type SolveSessionDetail = components["schemas"]["SolveSessionDetail"];
export type SolveMimicItem = components["schemas"]["SolveMimicItem"];
export type SolveMimicResult = components["schemas"]["SolveMimicResult"];
export type MimicAnswerResponse = components["schemas"]["MimicAnswerResponse"];
export type SolveAction = "submit_idea" | "hint" | "show_solution" | "locate_step" | "finish";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await browserApiFetch(path, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(publicMessage(body) ?? t.common.error, response.status, errorCodeOf(body));
  }
  return body as T;
}

export const solveKeys = {
  list: (courseId: string) => ["courses", courseId, "solve"] as const,
  one: (courseId: string, sessionId: string) => ["courses", courseId, "solve", sessionId] as const,
};

export const listSolveSessions = (courseId: string) =>
  request<SolveSessionSummary[]>(`/api/v2/courses/${courseId}/solve`);

export const getSolveSession = (courseId: string, sessionId: string) =>
  request<SolveSessionDetail>(`/api/v2/courses/${courseId}/solve/${sessionId}`);

export const createTextSolve = (courseId: string, body: { stem: string; kp_id?: string | null }) =>
  request<SolveSessionDetail>(`/api/v2/courses/${courseId}/solve`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const createImageSolve = (courseId: string, file: File, stem = "", kpId?: string | null) => {
  const form = new FormData();
  form.append("file", file);
  if (stem.trim()) form.append("stem", stem.trim());
  if (kpId) form.append("kp_id", kpId);
  return request<SolveSessionDetail>(`/api/v2/courses/${courseId}/solve/image`, {
    method: "POST",
    body: form,
  });
};

export const performSolveAction = (
  courseId: string,
  sessionId: string,
  body: { action: SolveAction; text?: string; step_index?: number | null },
) =>
  request<SolveSessionDetail>(`/api/v2/courses/${courseId}/solve/${sessionId}/action`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const generateSolveMimic = (courseId: string, sessionId: string, count = 1) =>
  request<SolveSessionDetail>(`/api/v2/courses/${courseId}/solve/${sessionId}/mimic`, {
    method: "POST",
    body: JSON.stringify({ count }),
  });

export const answerSolveMimic = (
  courseId: string,
  sessionId: string,
  itemId: string,
  body: { answer?: string | string[] | number | null; dont_know?: boolean },
) =>
  request<MimicAnswerResponse>(`/api/v2/courses/${courseId}/solve/${sessionId}/mimic/${itemId}/answer`, {
    method: "POST",
    body: JSON.stringify(body),
  });
