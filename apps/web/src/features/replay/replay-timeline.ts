import { captionDelay, type LessonEvent } from "../classroom/timeline";

export interface ReplayTimeline {
  offsetsMs: number[];
  totalMs: number;
}

export function buildReplayTimeline(events: readonly LessonEvent[], rate?: number): ReplayTimeline {
  const offsetsMs: number[] = [0];
  let acc = 0;
  for (const event of events) {
    const stepMs =
      event.type === "say"
        ? captionDelay(String(event.data.text ?? ""), rate)
        : 220;
    acc += stepMs;
    offsetsMs.push(acc);
  }
  return { offsetsMs, totalMs: acc };
}

export function indexAtTimeMs(timeline: ReplayTimeline, ms: number): number {
  const clamped = Math.max(0, Math.min(timeline.totalMs, ms));
  let best = 0;
  for (let i = 0; i < timeline.offsetsMs.length; i += 1) {
    if (timeline.offsetsMs[i] <= clamped) best = i;
    else break;
  }
  return best;
}

export function formatMediaTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
