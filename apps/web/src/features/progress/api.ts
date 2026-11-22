import { browserApiFetch } from "@companion-space/api-client";
import { ensureOK } from "../../app/api";

export interface ProgressPoint {
  id: string;
  name: string;
  unit_id: string | null;
  unit_title?: string;
  ord?: number;
  probability: number;
  status: string;
  evidence_count?: number;
  score_share?: number;
  weight?: number;
}

export interface CourseProgressData {
  studied_minutes: number;
  lessons_completed?: number;
  secured_score: number;
  score_scale: number;
  target_score?: number | null;
  has_exam_stats?: boolean;
  points: ProgressPoint[];
  trend: Array<{ day: string; probability: number; evidence_count: number }>;
  weekly_minutes?: Array<{ week_start: string; minutes: number }>;
}

export interface KpTimelineEvent {
  id: string;
  created_at: string;
  source: string;
  verdict: string;
  p_before: number;
  p_after: number;
}

export interface KpTimelineData {
  kp_id: string;
  kp_name: string;
  probability: number;
  status: string;
  events: KpTimelineEvent[];
}

export interface LearnerWeekSummary {
  days: Array<{ day: string; minutes: number; active: boolean }>;
  total_minutes: number;
  lessons_completed: number;
  streak_days: number;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await browserApiFetch(path);
  const body = await response.json();
  ensureOK(response, body);
  return body as T;
}

export const progressKeys = {
  course: (courseId: string) => ["courses", courseId, "progress"] as const,
  kpTimeline: (courseId: string, kpId: string) => ["courses", courseId, "kps", kpId, "timeline"] as const,
  weekSummary: ["learner", "week-summary"] as const,
};

export function fetchCourseProgress(courseId: string): Promise<CourseProgressData> {
  return fetchJson<CourseProgressData>(`/api/v2/courses/${encodeURIComponent(courseId)}/progress`);
}

export function fetchKpTimeline(courseId: string, kpId: string): Promise<KpTimelineData> {
  return fetchJson<KpTimelineData>(
    `/api/v2/courses/${encodeURIComponent(courseId)}/kps/${encodeURIComponent(kpId)}/timeline`,
  );
}

export function fetchLearnerWeekSummary(): Promise<LearnerWeekSummary> {
  return fetchJson<LearnerWeekSummary>("/api/v2/learner/week-summary");
}
