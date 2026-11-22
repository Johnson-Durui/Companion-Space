import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Loading, Problem } from "../../app/ui";
import {
  Badge,
  Button,
  Card,
  ChevronRight,
  Dialog,
  EmptyState,
  MasteryGrid,
  MasteryShapeGlyph,
  RotateCcw,
  ScoreBar,
  StudyCalendar,
  TutorAvatar,
  WeeklyMinutes,
  normalizeMasteryStatus,
  type MasteryGridPoint,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { createPointPlanItem } from "../classroom/lesson-api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import { fetchCourseProgress, fetchKpTimeline, progressKeys } from "./api";

const copy = t.progress;
const viz = t.loopViz;
const timeFmt = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function KpTimelineDialog({
  courseId,
  point,
  onClose,
}: {
  courseId: string;
  point: MasteryGridPoint | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const timeline = useQuery({
    queryKey: progressKeys.kpTimeline(courseId, point?.id ?? ""),
    queryFn: () => fetchKpTimeline(courseId, point!.id),
    enabled: Boolean(courseId && point?.id),
  });
  const reteach = useMutation({
    mutationFn: () => createPointPlanItem(courseId, point!.id),
    onSuccess: (created) => {
      onClose();
      navigate(`/plan-items/${created.plan_item_id}/lesson`);
    },
  });

  const statusKey = normalizeMasteryStatus(timeline.data?.status ?? point?.status ?? "unseen");
  const pct = Math.round((timeline.data?.probability ?? point?.probability ?? 0) * 100);

  return (
    <Dialog
      open={Boolean(point)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={point ? `${point.name} · ${viz.timelineTitle}` : viz.timelineTitle}
      size="md"
    >
      {point ? (
        <div className="grid gap-4" data-testid="kp-timeline-dialog">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-sunken/70 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <MasteryShapeGlyph status={statusKey} size={18} />
              <span className="text-ui font-medium text-fg-primary">
                {viz.masteryStatuses[statusKey]}
              </span>
              <span className="text-caption tabular-nums text-fg-secondary">{pct}%</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              pending={reteach.isPending}
              leftIcon={<RotateCcw size={14} aria-hidden="true" />}
              onClick={() => reteach.mutate()}
            >
              {viz.mapReteach}
            </Button>
          </div>
          {reteach.isError ? <Problem error={reteach.error} /> : null}

          {timeline.isPending ? (
            <Loading />
          ) : timeline.isError ? (
            <Problem error={timeline.error} onRetry={() => void timeline.refetch()} />
          ) : timeline.data.events.length === 0 ? (
            <p className="py-4 text-center text-ui text-fg-secondary">{viz.timelineEmpty}</p>
          ) : (
            <ol className="grid max-h-[340px] gap-2 overflow-y-auto pr-1">
              {timeline.data.events.map((ev) => {
                const sourceLabel =
                  viz.timelineSources[ev.source as keyof typeof viz.timelineSources] ?? ev.source;
                const verdictLabel =
                  t.classroom.verdicts[ev.verdict as keyof typeof t.classroom.verdicts] ?? ev.verdict;
                const isOk = ev.verdict === "correct";
                return (
                  <li
                    key={ev.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle bg-surface-page px-3 py-2 text-caption"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={isOk ? "ok" : "retry"}>{verdictLabel}</Badge>
                      <span className="font-medium text-fg-primary">{sourceLabel}</span>
                      <time className="text-fg-tertiary">{timeFmt.format(new Date(ev.created_at))}</time>
                    </div>
                    <span className="tabular-nums text-fg-secondary">
                      {Math.round(ev.p_before * 100)}% → {Math.round(ev.p_after * 100)}%
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export default function ProgressPage({ embedded = false }: { embedded?: boolean } = {}) {
  const courseId = useParams().courseId ?? "";
  const { tutor } = useActiveTutor();
  const [selectedPoint, setSelectedPoint] = useState<MasteryGridPoint | null>(null);

  const query = useQuery({
    queryKey: progressKeys.course(courseId),
    queryFn: () => fetchCourseProgress(courseId),
    enabled: Boolean(courseId),
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <Problem error={query.error} onRetry={() => void query.refetch()} />;

  const data = query.data;
  const masteredCount = data.points.filter((point) => point.status === "mastered").length;
  const lessonsCompleted = data.lessons_completed ?? 0;
  const hasAnyEvidence =
    data.studied_minutes > 0 ||
    lessonsCompleted > 0 ||
    data.trend.length > 0 ||
    data.points.some((point) => (point.evidence_count ?? 0) > 0 || point.status !== "unseen");

  const gridPoints: MasteryGridPoint[] = data.points.map((point) => ({
    id: point.id,
    name: point.name,
    unitId: point.unit_id,
    unitTitle: point.unit_title,
    probability: point.probability,
    status: point.status,
    weight: point.weight,
    evidenceCount: point.evidence_count,
  }));

  return (
    <div className="grid min-w-0 gap-5" data-testid="progress-page">
      {!embedded ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-1 text-caption text-fg-tertiary">
            <Link className="hover:text-fg-primary" to={`/courses/${courseId}`}>
              {copy.course}
            </Link>
            <ChevronRight size={14} aria-hidden="true" />
            <span>{copy.heading}</span>
          </div>
          <h1 className="text-headline font-semibold text-fg-primary">{copy.heading}</h1>
          <p className="text-ui text-fg-secondary">{copy.lead}</p>
        </div>
      ) : null}

      {!hasAnyEvidence ? (
        <Card padding="lg" data-testid="progress-empty">
          <EmptyState
            visual={tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="lg" /> : undefined}
            title={t.tutorsGallery.emptyProgressLine}
            description={copy.lead}
            action={
              <Link className="button primary" to={`/courses/${courseId}`}>
                {viz.reviewBackCourse}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* Three key counters */}
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label={copy.heading}>
            <Card padding="md" className="grid gap-1">
              <span className="text-caption text-fg-tertiary">{copy.minutes}</span>
              <strong className="text-headline font-semibold tabular-nums text-fg-primary">
                {data.studied_minutes}
              </strong>
            </Card>
            <Card padding="md" className="grid gap-1">
              <span className="text-caption text-fg-tertiary">{copy.mastered}</span>
              <strong className="text-headline font-semibold tabular-nums text-fg-primary">
                {masteredCount}
                <span className="ml-1 text-ui font-normal text-fg-tertiary">/ {data.points.length}</span>
              </strong>
            </Card>
            <Card padding="md" className="grid gap-1">
              <span className="text-caption text-fg-tertiary">{viz.lessonsCompleted}</span>
              <strong className="text-headline font-semibold tabular-nums text-fg-primary">
                {lessonsCompleted}
              </strong>
            </Card>
          </section>

          {/* ScoreBar (shown only when exam stats exist) */}
          {data.has_exam_stats ? (
            <Card padding="lg" className="grid gap-2">
              <h2 className="text-title font-semibold text-fg-primary">{copy.secured}</h2>
              <ScoreBar
                secured={data.secured_score}
                scale={data.score_scale}
                target={data.target_score}
                label={copy.secured}
                gapLabel={viz.scoreTargetGap}
                reachedLabel={
                  data.target_score != null
                    ? viz.scoreTargetReached.replace("{target}", String(data.target_score))
                    : undefined
                }
              />
            </Card>
          ) : null}

          {/* MasteryGrid (color + shape + weight, clickable for B5 timeline) */}
          <Card padding="lg" className="grid gap-3">
            <h2 className="text-title font-semibold text-fg-primary">{copy.map}</h2>
            <MasteryGrid
              points={gridPoints}
              statusLabels={viz.masteryStatuses}
              ungroupedLabel={viz.ungroupedUnit}
              highWeightLabel={viz.highWeightLegend}
              emptyLabel={t.courses.mapEmpty}
              onSelectPoint={setSelectedPoint}
            />
          </Card>

          {/* StudyCalendar (8 weeks + streak) & WeeklyMinutes */}
          <div className="grid gap-5 md:grid-cols-2">
            <Card padding="lg" className="grid gap-3">
              <h2 className="text-title font-semibold text-fg-primary">{viz.studyCalendarTitle}</h2>
              <StudyCalendar
                trend={data.trend}
                label={viz.studyCalendarTitle}
                activeDaysLabel={viz.studyCalendarActive}
                streakLabel={viz.studyCalendarStreak}
                emptyLabel={t.tutorsGallery.emptyProgressLine}
              />
            </Card>

            <Card padding="lg" className="grid gap-3">
              <h2 className="text-title font-semibold text-fg-primary">{viz.weeklyMinutesTitle}</h2>
              <WeeklyMinutes
                weeks={data.weekly_minutes ?? []}
                label={viz.weeklyMinutesTitle}
                unitLabel={t.learner.minutes}
                emptyLabel={viz.weeklyMinutesEmpty}
              />
            </Card>
          </div>
        </>
      )}

      <KpTimelineDialog
        courseId={courseId}
        point={selectedPoint}
        onClose={() => setSelectedPoint(null)}
      />
    </div>
  );
}
