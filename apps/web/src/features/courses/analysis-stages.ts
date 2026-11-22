/**
 * Maps the 10 sequential backend analysis stages into 4 student-facing coarse stages
 * (experience-design.md §5.5, documented in DECISIONS.md):
 *   0. 读资料:     parse, structure, index
 *   1. 整理知识点: kp_extract, kp_reduce
 *   2. 看真题:     exam_extract, item_verify, exam_stats
 *   3. 准备摸底题: diag_pool, brief
 */
export const BACKEND_STAGES = [
  "parse",
  "structure",
  "index",
  "kp_extract",
  "kp_reduce",
  "exam_extract",
  "item_verify",
  "exam_stats",
  "diag_pool",
  "brief",
] as const;

export const COARSE_STAGE_MAP: Record<string, number> = {
  parse: 0,
  structure: 0,
  index: 0,
  kp_extract: 1,
  kp_reduce: 1,
  exam_extract: 2,
  item_verify: 2,
  exam_stats: 2,
  diag_pool: 3,
  brief: 3,
};

export function coarseStageIndex(stage?: string | null): number {
  if (!stage) return 0;
  return COARSE_STAGE_MAP[stage] ?? 0;
}

/**
 * Estimate remaining minutes from elapsed time and completed fraction of backend stages.
 * Returns null when progress is too small or timestamps are missing.
 */
export function estimateRemainingMinutes(
  progress: number,
  createdAt?: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!createdAt || progress <= 0.12 || progress >= 0.99) return null;
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return null;
  const elapsedMs = nowMs - started;
  if (elapsedMs < 3_000) return null;
  const totalEstMs = elapsedMs / progress;
  const remainingMs = Math.max(0, totalEstMs - elapsedMs);
  return Math.max(1, Math.round(remainingMs / 60_000));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 102_400) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
