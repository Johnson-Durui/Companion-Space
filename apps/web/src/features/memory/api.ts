import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import { ApiError, errorCodeOf, publicMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";

export type MemoryEvidenceRef = components["schemas"]["MemoryEvidenceRef"];
export type CourseMemoryFact = components["schemas"]["CourseMemoryFact"];
export type GlobalSynthesisNote = components["schemas"]["GlobalSynthesisNote"];
export type MemoryArchiveResponse = components["schemas"]["MemoryArchiveResponse"];
export type MemoryStatus = "active" | "pinned" | "dismissed";

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

export const memoryKeys = {
  course: (courseId: string) => ["courses", courseId, "memories"] as const,
  archive: ["learner", "memory-archive"] as const,
};

export const listCourseMemories = (courseId: string) =>
  request<CourseMemoryFact[]>(`/api/v2/courses/${courseId}/memories`);

export const refreshCourseMemories = (courseId: string) =>
  request<CourseMemoryFact[]>(`/api/v2/courses/${courseId}/memories/refresh`, { method: "POST" });

export const patchCourseMemory = (
  courseId: string,
  memoryId: string,
  body: { statement?: string; status?: MemoryStatus },
) =>
  request<CourseMemoryFact>(`/api/v2/courses/${courseId}/memories/${memoryId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const getMemoryArchive = () =>
  request<MemoryArchiveResponse>("/api/v2/learner/memory-archive");

export const refreshMemoryArchive = () =>
  request<MemoryArchiveResponse>("/api/v2/learner/memory-archive/refresh", { method: "POST" });

export const patchGlobalMemoryNote = (
  noteId: string,
  body: { statement?: string; status?: MemoryStatus },
) =>
  request<MemoryArchiveResponse>(`/api/v2/learner/memory-archive/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
