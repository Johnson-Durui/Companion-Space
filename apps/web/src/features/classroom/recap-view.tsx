import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { LessonText } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import {
  ArrowLeft,
  ArrowRight,
  Badge,
  Button,
  Card,
  Download,
  Play,
  RotateCcw,
} from "../../ui";
import { isLessonItem, isTimedPracticeItem, planItemDisplayTitle } from "../plan/item-kind";
import { PlanDiffList, summarizePlanDiff } from "../plan/plan-diff";
import { masteryLabel } from "../plan/why-sentence";
import type { PlanDiff } from "../learner/api";
import { boardMarkdown, type Block } from "./board";
import { BoardBlock } from "./board-block";
import { createPointPlanItem, fetchLessonRecapSummary } from "./lesson-api";

const copy = t.classroom;
const recapCopy = t.recapView;
const dateFmt = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

function downloadBoardMarkdown(title: string, board: Block[]) {
  const md = boardMarkdown(board);
  const blob = new Blob([`# ${title}\n\n${md}\n`], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title || "board"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface RecapViewProps {
  lessonId: string;
  courseId: string;
  title: string;
  summary?: string;
  board: Block[];
}

export function RecapView({ lessonId, courseId, title, summary, board }: RecapViewProps) {
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["lesson-recap-summary", lessonId],
    queryFn: () => fetchLessonRecapSummary(lessonId),
    enabled: Boolean(lessonId),
  });

  const reteach = useMutation({
    mutationFn: (kpId: string) => createPointPlanItem(courseId, kpId),
    onSuccess: (created) => navigate(`/plan-items/${created.plan_item_id}/lesson`),
  });

  const data = detail.data;
  const abandoned = Boolean(data?.abandoned);
  const minutes = data ? Math.max(1, Math.round((data.stats.active_ms || 0) / 60_000)) : null;
  const finishedDate = data?.finished_at ? dateFmt.format(new Date(data.finished_at)) : null;
  const displaySummary = (summary && summary.trim()) || data?.summary || "";

  const adaptLine = data
    ? data.stats.style_switches > 0 && data.stats.backfill_count > 0
      ? recapCopy.adaptBoth
          .replace("{switches}", String(data.stats.style_switches))
          .replace("{backfills}", String(data.stats.backfill_count))
      : data.stats.style_switches > 0
        ? recapCopy.adaptSwitchOnly.replace("{switches}", String(data.stats.style_switches))
        : data.stats.backfill_count > 0
          ? recapCopy.adaptBackfillOnly.replace("{backfills}", String(data.stats.backfill_count))
          : ""
    : "";

  const nextItem = data?.next ?? null;
  const nextHref = nextItem
    ? isLessonItem(nextItem.kind)
      ? nextItem.lesson_id
        ? `/lessons/${nextItem.lesson_id}`
        : `/plan-items/${nextItem.id}/lesson`
      : isTimedPracticeItem(nextItem.kind)
        ? `/plan-items/${nextItem.id}/practice`
        : `/courses/${courseId}/plan`
    : null;

  return (
    <div
      data-surface="desk"
      data-phase="ended"
      data-testid="lesson-recap"
      className="min-h-dvh bg-surface-page text-fg-primary"
    >
      <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[880px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-1.5 text-ui font-medium text-fg-secondary hover:text-fg-primary"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{t.app.backToday}</span>
          </Link>
          <span className="truncate text-caption text-fg-tertiary">{title}</span>
        </div>
      </header>

      <main id="main" className="mx-auto grid max-w-[880px] gap-5 px-4 py-8 sm:px-6">
        <div className="grid gap-1.5">
          <p className="text-caption font-medium text-accent-strong">
            {abandoned ? recapCopy.abandonedTitle : copy.recap}
          </p>
          <h1 className="text-display font-semibold text-fg-primary">{title}</h1>
          {finishedDate || minutes ? (
            <p className="text-ui text-fg-secondary">
              {[finishedDate, minutes ? recapCopy.duration.replace("{min}", String(minutes)) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>

        {abandoned ? (
          <Card padding="lg" className="grid gap-4">
            <p className="text-body text-fg-secondary">{recapCopy.abandonedHint}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => window.location.reload()}>
                {recapCopy.resumeThis}
              </Button>
              <Link className="button quiet" to={`/courses/${courseId}`}>
                {copy.back}
              </Link>
            </div>
          </Card>
        ) : (
          <>
            {/* B2 Stats */}
            {data ? (
              <Card padding="lg" className="grid gap-3" data-testid="recap-stats">
                <h2 className="text-title font-semibold text-fg-primary">{recapCopy.achievedTitle}</h2>
                <div className="flex flex-wrap gap-2">
                  {data.stats.keypoints_total > 0 ? (
                    <Badge tone="accent">
                      {recapCopy.keypoints
                        .replace("{done}", String(data.stats.keypoints_done))
                        .replace("{total}", String(data.stats.keypoints_total))}
                    </Badge>
                  ) : null}
                  {data.stats.correct_count > 0 ? (
                    <Badge tone="ok">
                      {recapCopy.correct.replace("{count}", String(data.stats.correct_count))}
                    </Badge>
                  ) : null}
                  {data.stats.correct_with_hint_count > 0 ? (
                    <Badge tone="neutral">
                      {recapCopy.correctHint.replace("{count}", String(data.stats.correct_with_hint_count))}
                    </Badge>
                  ) : null}
                  {data.stats.revealed_count > 0 ? (
                    <Badge tone="warn">
                      {recapCopy.revealed.replace("{count}", String(data.stats.revealed_count))}
                    </Badge>
                  ) : null}
                </div>
                {adaptLine ? <p className="text-ui text-fg-secondary">{adaptLine}</p> : null}
              </Card>
            ) : null}

            {/* Teacher Summary */}
            {displaySummary ? (
              <Card padding="lg" className="grid gap-3">
                <h2 className="text-title font-semibold text-fg-primary">{recapCopy.teacherSummary}</h2>
                <div className="prose-like text-body leading-relaxed text-fg-primary">
                  <LessonText source={displaySummary} />
                </div>
              </Card>
            ) : null}

            {/* Mastery Changes */}
            {data?.mastery_changes && data.mastery_changes.length > 0 ? (
              <Card padding="lg" className="grid gap-3" data-testid="recap-mastery">
                <h2 className="text-title font-semibold text-fg-primary">{recapCopy.masteryChanges}</h2>
                <ul className="grid gap-2.5">
                  {data.mastery_changes.map((entry) => {
                    const shaky = entry.status !== "mastered";
                    return (
                      <li
                        key={entry.kp_id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-page px-3.5 py-2.5"
                      >
                        <div className="grid gap-0.5">
                          <strong className="text-ui font-medium text-fg-primary">{entry.kp_name}</strong>
                          <span className="text-caption text-fg-secondary">
                            {masteryLabel(entry.p_before)} → {masteryLabel(entry.p_after)} ({Math.round(entry.p_before * 100)}% → {Math.round(entry.p_after * 100)}%)
                          </span>
                        </div>
                        {shaky ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            pending={reteach.isPending}
                            leftIcon={<RotateCcw size={14} aria-hidden="true" />}
                            onClick={() => reteach.mutate(entry.kp_id)}
                          >
                            {recapCopy.reteach}
                          </Button>
                        ) : (
                          <Badge tone="ok">{t.today.masteryMastered}</Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ) : null}

            {/* Next Actions */}
            <Card padding="lg" className="grid gap-4">
              <h2 className="text-title font-semibold text-fg-primary">{recapCopy.nextTitle}</h2>
              {data?.plan_change?.changed ? (
                <div className="grid gap-1.5 rounded-md bg-accent-soft/50 px-3.5 py-2.5 text-ui text-fg-primary">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {recapCopy.planAdjusted}
                      {summarizePlanDiff(data.plan_change.diff as PlanDiff | null | undefined)
                        ? `：${summarizePlanDiff(data.plan_change.diff as PlanDiff | null | undefined)}`
                        : ""}
                    </span>
                    <Link className="font-medium text-accent-strong hover:underline" to={`/courses/${courseId}/plan`}>
                      {recapCopy.viewPlan}
                    </Link>
                  </div>
                  <PlanDiffList diff={data.plan_change.diff as PlanDiff | null | undefined} compact />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {nextItem && nextHref ? (
                  <Link className="button primary" to={nextHref}>
                    <Play size={15} aria-hidden="true" />
                    <span>{recapCopy.nextLesson.replace("{title}", planItemDisplayTitle(nextItem))}</span>
                  </Link>
                ) : (
                  <Link className="button primary" to={`/courses/${courseId}`}>
                    <span>{copy.back}</span>
                    <ArrowRight size={15} aria-hidden="true" />
                  </Link>
                )}

                {typeof data?.review_cards_created === "number" && data.review_cards_created > 0 ? (
                  <Link className="button quiet" to={`/courses/${courseId}/review`}>
                    {recapCopy.newReviewCards.replace("{count}", String(data.review_cards_created))}
                  </Link>
                ) : null}

                <Link className="button quiet" to={`/lessons/${lessonId}/history`}>
                  {t.history.replay}
                </Link>
                {nextItem ? (
                  <Link className="button quiet" to={`/courses/${courseId}`}>
                    {copy.back}
                  </Link>
                ) : null}
              </div>
            </Card>
          </>
        )}

        {/* Board Notes */}
        {board.length > 0 ? (
          <Card padding="md">
            <details className="grid gap-3">
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-ui font-semibold text-fg-primary select-none">
                <span>{recapCopy.boardNotes}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Download size={14} aria-hidden="true" />}
                  onClick={(event) => {
                    event.preventDefault();
                    downloadBoardMarkdown(title, board);
                  }}
                >
                  {recapCopy.downloadBoard}
                </Button>
              </summary>
              <div className="grid gap-4 pt-3">
                {board.map((block) => (
                  <BoardBlock key={block.id} block={block} />
                ))}
              </div>
            </details>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
