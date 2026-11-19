import { ensureOK } from "../../app/api";
import type { LessonEvent } from "../classroom/timeline";
import t from "../../locales/zh-CN.json";

export type Sample = {
  schema_version: 1;
  model: string;
  recorded_at: string;
  title: string;
  course: string;
  events: LessonEvent[];
  branches: Record<string, Record<string, string[]>>;
  recap: { summary?: string } | null;
};

export const sampleKey = ["sample-lesson"] as const;

export async function fetchSample(): Promise<Sample | null> {
  const res = await fetch("/api/v2/sample-lesson");
  if (res.status === 404) return null;
  const payload = await res.json();
  ensureOK(res, payload);
  if (payload?.schema_version !== 1 || !Array.isArray(payload.events) || !payload.branches) throw new Error(t.sample.unavailable);
  return payload as Sample;
}
