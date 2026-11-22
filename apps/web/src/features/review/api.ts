import { browserApiFetch } from "@companion-space/api-client";
import { ensureOK } from "../../app/api";

export interface MasterySnapshot {
  probability: number;
  status: string;
}

export type ReviewCard = {
  id: string;
  kp_id: string | null;
  kp_name?: string | null;
  kind: "flashcard" | "item";
  front: string;
  back?: string;
  due_at: string;
  state?: string;
  item?: {
    type: string;
    stem: string;
    options?: Record<string, string> | Array<{ key: string; text: string }>;
  };
};

export type MistakeCard = ReviewCard & {
  kp_name: string | null;
  original_mistake: null | {
    verdict: string;
    detail: { answer?: unknown; gap?: string };
    created_at: string;
  };
};

export interface RateCardResult {
  id: string;
  due_at: string;
  state: string;
  kp_id?: string | null;
  kp_name?: string | null;
  before_mastery?: MasterySnapshot | null;
  mastery?: MasterySnapshot | null;
}

export interface AnswerCardResult {
  card_id: string;
  verdict: string;
  rating: string;
  answer?: unknown;
  solution: string;
  due_at: string;
  state: string;
  kp_id?: string | null;
  kp_name?: string | null;
  before_mastery?: MasterySnapshot | null;
  mastery?: MasterySnapshot | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await browserApiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  ensureOK(response, body);
  return body as T;
}

export const reviewKey = (courseId: string, plan?: string | null) =>
  ["courses", courseId, "review", plan] as const;

export const mistakesKey = (courseId: string, kpId: string, since: string, archived: boolean) =>
  ["courses", courseId, "mistakes", kpId, since, archived] as const;

export const getReview = (courseId: string, plan?: string | null) =>
  request<{ cards: ReviewCard[] }>(
    `/api/v2/courses/${encodeURIComponent(courseId)}/review${plan ? `?plan_item_id=${encodeURIComponent(plan)}` : ""}`,
  );

export const startPlannedLesson = (plan: string) =>
  request<{ id: string }>(`/api/v2/plan-items/${encodeURIComponent(plan)}/lesson`, {
    method: "POST",
  });

export const rateCard = (cardId: string, rating: string) =>
  request<RateCardResult>(`/api/v2/review/cards/${encodeURIComponent(cardId)}/rate`, {
    method: "POST",
    body: JSON.stringify({ rating }),
  });

export const answerCard = (cardId: string, answer: unknown, dontKnow = false) =>
  request<AnswerCardResult>(`/api/v2/review/cards/${encodeURIComponent(cardId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer, dont_know: dontKnow }),
  });

export const getMistakes = (courseId: string, kpId: string, since: string, archived: boolean) => {
  const query = new URLSearchParams();
  if (kpId) query.set("kp_id", kpId);
  if (since) query.set("since", since);
  if (archived) query.set("archived", "true");
  return request<{ cards: MistakeCard[] }>(`/api/v2/courses/${encodeURIComponent(courseId)}/mistakes?${query}`);
};
