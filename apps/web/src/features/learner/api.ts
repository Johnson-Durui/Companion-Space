import type { paths } from "@companion-space/api-client/schema";
import { browserApiFetch } from "@companion-space/api-client";
import { api, bodyOf, ensureOK } from "../../app/api";

type ProfileInput = paths["/api/v2/learner/profile"]["put"]["requestBody"]["content"]["application/json"];
type EnrollmentInput = paths["/api/v2/courses/{course_id}/enrollment"]["put"]["requestBody"]["content"]["application/json"];

export const learnerKeys = {
  profile: ["learner", "profile"] as const,
  enrollment: (courseId: string) => ["courses", courseId, "enrollment"] as const,
  interview: (courseId: string) => ["courses", courseId, "interview"] as const,
  placement: (courseId: string) => ["courses", courseId, "placement"] as const,
  plan: (courseId: string) => ["courses", courseId, "plan"] as const,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await browserApiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  ensureOK(response, body);
  return body as T;
}

export type InterviewState = {
  topics: string[]; completed: string[]; current: string | null; status: string;
  question: string | null; rendered: boolean; fallback_to_chips: boolean;
  tutor: null | { id: string; name: string; voice: { voice_id: string; rate: number; pitch: number } };
};
export type Placement = {
  status: string;
  unavailable_reason?: "materials_not_ready" | "no_questions" | null;
  question: null | { item_id: string; kp_id: string; type: string; stem: string; options: Record<string, string> | Array<{ key: string; text: string }>; answered: number; started_at: string };
  mastery: Array<{ kp_id: string; name: string; unit_id: string | null; probability: number; status: string | null; inferred: boolean }>;
  summary: null | { strongest_name: string; strongest_probability: number; priority_name: string; priority_probability: number; inferred_count: number };
};
export type StudyPlan = {
  version: number;
  reason?: string;
  deferred: string[];
  params?: { hints_mapping?: "unused" | "mapped" | "unavailable" };
  items: Array<{ id: string; kind: string; title: string; scheduled_date: string | null; est_minutes: number; kp_ids: string[]; pinned: number; status: string; why: Array<{ kp_id: string; weight: number; mastery: number }> }>;
};

export const getInterview = (courseId: string) => request<InterviewState>(`/api/v2/courses/${courseId}/interview`);
export const answerInterview = (courseId: string, topic: string, values: Record<string, unknown>, text = "") => request<InterviewState>(
  `/api/v2/courses/${courseId}/interview/answer`, { method: "POST", body: JSON.stringify({ topic, values, text }) },
);
export const skipInterview = (courseId: string) => request<InterviewState>(
  `/api/v2/courses/${courseId}/interview/skip`, { method: "POST", body: "{}" },
);
export const getPlacement = (courseId: string) => request<Placement>(`/api/v2/courses/${courseId}/placement`);
export const answerPlacement = (courseId: string, body: { item_id: string; answer?: string | string[] | number; dont_know?: boolean }) => request<Placement>(
  `/api/v2/courses/${courseId}/placement/answer`, { method: "POST", body: JSON.stringify(body) },
);
export const finishPlacement = (courseId: string) => request<Placement>(
  `/api/v2/courses/${courseId}/placement/finish`, { method: "POST", body: "{}" },
);
export const restartPlacement = (courseId: string) => request<Placement>(
  `/api/v2/courses/${courseId}/placement/restart`, { method: "POST", body: "{}" },
);
export const getPlan = (courseId: string) => request<StudyPlan>(`/api/v2/courses/${courseId}/plan`);
export const createPlan = (courseId: string) => request<StudyPlan>(
  `/api/v2/courses/${courseId}/plan`, { method: "POST", body: JSON.stringify({ reason: "manual" }) },
);
export const replan = (courseId: string) => request<StudyPlan>(
  `/api/v2/courses/${courseId}/plan/replan`, { method: "POST", body: JSON.stringify({ reason: "manual" }) },
);
export const adjustPlanItem = (itemId: string, body: { direction?: "first" | "earlier" | "later"; pinned?: boolean }) => request<StudyPlan>(
  `/api/v2/plan-items/${itemId}`, { method: "PATCH", body: JSON.stringify(body) },
);

export async function getLearnerProfile() {
  return bodyOf(await api.GET("/api/v2/learner/profile"));
}

export async function saveLearnerProfile(body: ProfileInput) {
  return bodyOf(await api.PUT("/api/v2/learner/profile", { body }));
}

export async function getEnrollment(courseId: string) {
  return bodyOf(await api.GET("/api/v2/courses/{course_id}/enrollment", { params: { path: { course_id: courseId } } }));
}

export async function saveEnrollment(
  courseId: string,
  body: EnrollmentInput,
) {
  return bodyOf(await api.PUT("/api/v2/courses/{course_id}/enrollment", {
    params: { path: { course_id: courseId } }, body,
  }));
}

export type LearnerProfile = Awaited<ReturnType<typeof getLearnerProfile>>;
export type CourseEnrollment = Awaited<ReturnType<typeof getEnrollment>>;
