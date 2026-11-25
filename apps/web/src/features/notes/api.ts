import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import { ApiError, errorCodeOf, publicMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";

export type ReaderKpBadge = components["schemas"]["ReaderKpBadge"];
export type ReaderOverviewResponse = components["schemas"]["ReaderOverviewResponse"];
export type ReaderPageResponse = components["schemas"]["ReaderPageResponse"];
export type ReaderAskResponse = components["schemas"]["ReaderAskResponse"];
export type ReaderQuizAnswerResponse = components["schemas"]["ReaderQuizAnswerResponse"];
export type CourseNoteSummary = components["schemas"]["CourseNoteSummary"];
export type NoteBlockItem = components["schemas"]["NoteBlockItem"];
export type CourseNoteDetail = components["schemas"]["CourseNoteDetail"];
export type NoteSuggestionItem = components["schemas"]["NoteSuggestionItem"];
export type NoteFlashcardResponse = components["schemas"]["NoteFlashcardResponse"];

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

export const readerKeys = {
  overview: (courseId: string, materialId: string) =>
    ["courses", courseId, "materials", materialId, "reader"] as const,
  page: (courseId: string, materialId: string, pageNo: number) =>
    ["courses", courseId, "materials", materialId, "reader", "page", pageNo] as const,
};

export const notesKeys = {
  list: (courseId: string) => ["courses", courseId, "notes"] as const,
  one: (courseId: string, noteId: string) => ["courses", courseId, "notes", noteId] as const,
};

export const getReaderOverview = (courseId: string, materialId: string) =>
  request<ReaderOverviewResponse>(`/api/v2/courses/${courseId}/materials/${materialId}/reader`);

export const getReaderPage = (courseId: string, materialId: string, pageNo: number) =>
  request<ReaderPageResponse>(`/api/v2/courses/${courseId}/materials/${materialId}/pages/${pageNo}/reader`);

export const askReaderPage = (
  courseId: string,
  materialId: string,
  pageNo: number,
  body: { passage: string; question?: string },
) =>
  request<ReaderAskResponse>(`/api/v2/courses/${courseId}/materials/${materialId}/pages/${pageNo}/ask`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const answerReaderQuickCheck = (
  courseId: string,
  itemId: string,
  body: { answer?: string | string[] | number | null; dont_know?: boolean },
) =>
  request<ReaderQuizAnswerResponse>(`/api/v2/courses/${courseId}/reader/quiz/${itemId}/answer`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const listCourseNotes = (courseId: string) =>
  request<CourseNoteSummary[]>(`/api/v2/courses/${courseId}/notes`);

export const createCourseNote = (courseId: string, body: { title: string; kp_id?: string | null }) =>
  request<CourseNoteDetail>(`/api/v2/courses/${courseId}/notes`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getCourseNote = (courseId: string, noteId: string) =>
  request<CourseNoteDetail>(`/api/v2/courses/${courseId}/notes/${noteId}`);

export const deleteCourseNote = (courseId: string, noteId: string) =>
  request<void>(`/api/v2/courses/${courseId}/notes/${noteId}`, { method: "DELETE" });

export const addNoteBlock = (
  courseId: string,
  noteId: string,
  body: {
    block_type: string;
    title?: string | null;
    content: string;
    source_ref?: Record<string, unknown> | null;
    default_title?: string;
  },
) =>
  request<CourseNoteDetail>(`/api/v2/courses/${courseId}/notes/${noteId}/blocks`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateNoteBlock = (
  courseId: string,
  noteId: string,
  blockId: string,
  body: { title?: string | null; content?: string; ord?: number },
) =>
  request<CourseNoteDetail>(`/api/v2/courses/${courseId}/notes/${noteId}/blocks/${blockId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteNoteBlock = (courseId: string, noteId: string, blockId: string) =>
  request<CourseNoteDetail>(`/api/v2/courses/${courseId}/notes/${noteId}/blocks/${blockId}`, {
    method: "DELETE",
  });

export const suggestNoteAdditions = (courseId: string, noteId: string) =>
  request<NoteSuggestionItem[]>(`/api/v2/courses/${courseId}/notes/${noteId}/suggest`, {
    method: "POST",
  });

export const createFlashcardFromNoteBlock = (
  courseId: string,
  noteId: string,
  blockId: string,
  body: { front?: string; back?: string } = {},
) =>
  request<NoteFlashcardResponse>(`/api/v2/courses/${courseId}/notes/${noteId}/blocks/${blockId}/flashcard`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export function noteExportUrl(courseId: string, noteId: string, format: "md" | "anki_tsv"): string {
  return `/api/v2/courses/${encodeURIComponent(courseId)}/notes/${encodeURIComponent(noteId)}/export?format=${format}`;
}
