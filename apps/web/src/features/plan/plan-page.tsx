import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import clsx from "clsx";
import { Loading, Problem } from "../../app/ui";
import {
  Badge,
  Button,
  Card,
  ChevronDown,
  ChevronUp,
  EmptyState,
  MasteryBar,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  WeightBar,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { courseKeys } from "../courses/api";
import { adjustPlanItem, getEnrollment, getPlan, learnerKeys, replan, type StudyPlan } from "../learner/api";
import { ConnectWizardDialog } from "../settings/connect-wizard";
import { useReadiness } from "../settings/use-readiness";
import { isLessonItem, isTimedPracticeItem, planItemDisplayTitle, planItemKindLabel } from "./item-kind";
import { PlanDiffList } from "./plan-diff";
import { buildPlanWhySentence, masteryLabel, masteryLevel, weightLabel } from "./why-sentence";

const copy = t.planView;
const dateFmt = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function startOfWeek(ref: Date): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  return d;
}

function groupPlanItems(items: StudyPlan["items"], hasExamDate: boolean) {
  if (!hasExamDate) {
    return [{ id: "seq", label: copy.unscheduledGroup, items }];
  }
  const now = new Date();
  const thisMon = startOfWeek(now).getTime();
  const nextMon = thisMon + 7 * 86_400_000;
  const thirdMon = nextMon + 7 * 86_400_000;

  const groups: Array<{ id: string; label: string; items: StudyPlan["items"] }> = [
    { id: "this", label: copy.thisWeek, items: [] },
    { id: "next", label: copy.nextWeek, items: [] },
    { id: "later", label: copy.laterWeeks, items: [] },
  ];
  for (const item of items) {
    if (!item.scheduled_date) {
      groups[2].items.push(item);
      continue;
    }
    const ts = Date.parse(`${item.scheduled_date}T00:00:00`);
    if (ts < nextMon) groups[0].items.push(item);
    else if (ts < thirdMon) groups[1].items.push(item);
    else groups[2].items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

export function PlanItemWhyPanel({ why }: { why: StudyPlan["items"][number]["why"] }) {
  if (!why.length) return null;
  return (
    <div className="mt-3 grid gap-2.5 border-t border-line-subtle pt-3">
      {why.map((entry) => (
        <div key={entry.kp_id} className="grid gap-1.5 rounded-md bg-surface-sunken/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-ui font-medium text-fg-primary">
              {entry.kp_name || entry.kp_id}
            </strong>
            {entry.highlighted ? <Badge tone="accent">{copy.teacherHintBadge}</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
            <WeightBar
              weight={entry.weight}
              label={t.today.weightLabel}
              valueText={weightLabel(entry.weight)}
            />
            <MasteryBar
              probability={entry.mastery}
              status={masteryLevel(entry.mastery)}
              label={t.today.masteryLabel}
              valueText={masteryLabel(entry.mastery)}
            />
          </div>
          <p className="text-ui text-fg-secondary">{buildPlanWhySentence(entry)}</p>
        </div>
      ))}
    </div>
  );
}

export default function PlanPage() {
  const courseId = useParams().courseId ?? "";
  const queries = useQueryClient();
  const readiness = useReadiness();
  const [connectOpen, setConnectOpen] = useState(false);
  const [expandedWhy, setExpandedWhy] = useState<Record<string, boolean>>({});
  const [recentMovedId, setRecentMovedId] = useState<string | null>(null);

  const plan = useQuery({
    queryKey: learnerKeys.plan(courseId),
    queryFn: () => getPlan(courseId),
    enabled: Boolean(courseId),
  });
  const enrollment = useQuery({
    queryKey: learnerKeys.enrollment(courseId),
    queryFn: () => getEnrollment(courseId),
    enabled: Boolean(courseId),
  });

  const adjust = useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: "first" | "later" | "unpin" }) =>
      adjustPlanItem(itemId, action === "unpin" ? { pinned: false } : { direction: action }),
    onMutate: async ({ itemId, action }) => {
      await queries.cancelQueries({ queryKey: learnerKeys.plan(courseId) });
      const previous = queries.getQueryData<StudyPlan>(learnerKeys.plan(courseId));
      if (previous) {
        const items = [...previous.items];
        const idx = items.findIndex((entry) => entry.id === itemId);
        if (idx >= 0) {
          const target =
            action === "first" ? 0 : action === "later" ? Math.min(items.length - 1, idx + 1) : idx;
          if (target !== idx) {
            const [moved] = items.splice(idx, 1);
            items.splice(target, 0, { ...moved, pinned: 1 });
          } else if (action === "unpin") {
            items[idx] = { ...items[idx], pinned: 0 };
          }
          queries.setQueryData<StudyPlan>(learnerKeys.plan(courseId), { ...previous, items });
        }
      }
      setRecentMovedId(itemId);
      window.setTimeout(() => setRecentMovedId((cur) => (cur === itemId ? null : cur)), 700);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queries.setQueryData(learnerKeys.plan(courseId), ctx.previous);
    },
    onSuccess: (next) => {
      queries.setQueryData(learnerKeys.plan(courseId), next);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      toast.success(t.common.saved);
    },
  });

  const rebuild = useMutation({
    mutationFn: () => replan(courseId),
    onSuccess: (next) => {
      queries.setQueryData(learnerKeys.plan(courseId), next);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      toast.success(t.common.saved);
    },
  });

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  if (plan.isPending) return <Loading />;
  if (plan.isError) return <Problem error={plan.error} onRetry={() => void plan.refetch()} />;

  const data = plan.data;
  if (!data || !data.items.length) {
    return (
      <EmptyState
        title={copy.emptyTitle}
        description={copy.emptyHint}
        action={
          <Link className="button primary" to={`/courses/${courseId}/setup`}>
            {copy.goSetup}
          </Link>
        }
      />
    );
  }

  const hasExamDate = Boolean(enrollment.data?.exam_date || data.params?.exam_date);
  const groups = groupPlanItems(data.items, hasExamDate);
  const reasonText = data.reason
    ? (copy.reasons[data.reason as keyof typeof copy.reasons] ?? data.reason)
    : copy.reasons.setup;
  const createdText = data.created_at ? timeFmt.format(new Date(data.created_at)) : "";
  const firstActionableId =
    data.items.find((item) => item.status === "active" || item.status === "todo")?.id ?? null;
  const deferredList =
    data.deferred_items?.length
      ? data.deferred_items
      : data.deferred.map((id) => ({ kp_id: id, kp_name: id }));

  return (
    <div className="grid gap-5" data-testid="course-plan-page">
      {/* Explanation Bar + B4b Diff List */}
      <Card padding="md" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            {createdText ? (
              <p className="text-ui font-medium text-fg-primary">
                {copy.reasonBar.replace("{time}", createdText).replace("{reason}", reasonText)}
              </p>
            ) : null}
            {!hasExamDate && enrollment.data ? (
              <p className="text-caption text-fg-secondary">
                {t.setup.step5SummaryNoExam
                  .replace("{daysPerWeek}", String((enrollment.data.weekly_days ?? []).length))
                  .replace("{min}", String(enrollment.data.session_minutes ?? 30))}
              </p>
            ) : null}
            {data.params?.hints_mapping === "unavailable" ? (
              <p className="text-caption text-warn-text" role="status">
                {t.learner.hintsMappingUnavailable}
              </p>
            ) : null}
          </div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={14} aria-hidden="true" />}
            pending={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            {t.learner.rebuildPlan}
          </Button>
        </div>
        <PlanDiffList diff={data.diff} />
      </Card>

      {adjust.isError ? <Problem error={adjust.error} /> : null}
      {rebuild.isError ? <Problem error={rebuild.error} /> : null}

      {/* Week-grouped Timeline */}
      {groups.map((group) => (
        <section key={group.id} className="grid gap-3">
          <h2 className="text-ui font-semibold text-fg-secondary">{group.label}</h2>
          <ol className="grid gap-3" data-testid="plan-timeline">
            {group.items.map((item) => {
              const isToday = Boolean(item.scheduled_date && item.scheduled_date <= todayIso && item.status !== "done" && item.status !== "skipped");
              const isFirst = item.id === firstActionableId;
              const isDone = item.status === "done" || item.status === "skipped";
              const isHighlighted = item.why.some((entry) => entry.highlighted);
              const isRecentlyMoved = recentMovedId === item.id;
              const whyOpen = Boolean(expandedWhy[item.id]);
              const lessonTarget =
                item.status === "active" && item.lesson_id
                  ? `/lessons/${item.lesson_id}`
                  : `/plan-items/${item.id}/lesson`;

              return (
                <li
                  key={item.id}
                  data-testid="plan-item"
                  data-status={item.status}
                  className={clsx(
                    "rounded-lg border bg-surface-card p-4 shadow-1 transition-[transform,background-color,border-color,box-shadow] duration-base ease-out",
                    isToday ? "border-accent/50 bg-accent-soft/20" : "border-line-subtle",
                    isRecentlyMoved && "ring-2 ring-accent/45 -translate-y-0.5 shadow-2",
                    isDone && "opacity-75",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid min-w-0 gap-1">
                      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
                        {hasExamDate && item.scheduled_date ? (
                          <span>
                            {item.scheduled_date === todayIso
                              ? copy.todayTag
                              : dateFmt.format(new Date(`${item.scheduled_date}T00:00:00`))}
                          </span>
                        ) : null}
                        <Badge tone={isLessonItem(item.kind) ? "accent" : "neutral"}>
                          {planItemKindLabel(item.kind)}
                        </Badge>
                        <span>{t.today.estMinutes.replace("{min}", String(item.est_minutes))}</span>
                        {isHighlighted ? <Badge tone="accent">{copy.teacherHintBadge}</Badge> : null}
                        {item.pinned ? <Badge tone="neutral">{t.learner.pinned}</Badge> : null}
                        {item.status === "done" ? <Badge tone="ok">{copy.statusDone}</Badge> : null}
                        {item.status === "skipped" ? <Badge tone="neutral">{copy.statusSkipped}</Badge> : null}
                        {item.status === "active" ? <Badge tone="warn">{copy.statusActive}</Badge> : null}
                      </div>
                      <h3 className="text-body font-semibold text-fg-primary">
                        {planItemDisplayTitle(item)}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {!isDone && isLessonItem(item.kind) ? (
                        isFirst && !readiness.readyForLessons ? (
                          <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
                            {t.today.connectFirst}
                          </Button>
                        ) : (
                          <Link
                            className={isFirst ? "button primary" : "button quiet"}
                            to={lessonTarget}
                          >
                            <Play size={14} aria-hidden="true" />
                            <span>{item.status === "active" ? copy.continue : copy.start}</span>
                          </Link>
                        )
                      ) : null}

                      {!isDone && isTimedPracticeItem(item.kind) ? (
                        <Link
                          className={isFirst ? "button primary" : "button quiet"}
                          to={`/plan-items/${item.id}/practice`}
                        >
                          {t.practice.open}
                        </Link>
                      ) : null}

                      {item.status === "todo" ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            pending={adjust.isPending}
                            leftIcon={item.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                            onClick={() =>
                              adjust.mutate({ itemId: item.id, action: item.pinned ? "unpin" : "first" })
                            }
                          >
                            {item.pinned ? t.learner.unpin : t.learner.pinFirst}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            pending={adjust.isPending}
                            onClick={() => adjust.mutate({ itemId: item.id, action: "later" })}
                          >
                            {t.learner.moveLater}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {item.why.length > 0 ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        aria-expanded={whyOpen}
                        onClick={() =>
                          setExpandedWhy((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                        }
                        className="inline-flex min-h-8 items-center gap-1 text-caption font-medium text-fg-secondary hover:text-accent-strong"
                      >
                        {whyOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                        <span>{copy.whyToggle}</span>
                      </button>
                      {whyOpen ? <PlanItemWhyPanel why={item.why} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {/* Deferred Section (B4a) */}
      {deferredList.length > 0 ? (
        <Card padding="lg" className="grid gap-3" data-testid="plan-deferred">
          <div className="grid gap-1">
            <h2 className="text-title font-semibold text-fg-primary">{copy.deferredTitle}</h2>
            <p className="text-ui text-fg-secondary">
              {typeof data.deferred_weight === "number"
                ? copy.deferredSummary.replace("{weight}", String(Math.round(data.deferred_weight * 100)))
                : copy.deferredSummaryPlain}
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {deferredList.map((entry) => (
              <li
                key={entry.kp_id}
                className="rounded-md border border-line-subtle bg-surface-page px-3 py-1.5 text-ui text-fg-primary"
              >
                {entry.kp_name}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConnectWizardDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
