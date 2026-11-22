import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Loading, Problem } from "../../app/ui";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChevronRight,
  Dialog,
  EmptyState,
  Play,
  RotateCcw,
  Select,
  TutorAvatar,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { createPointPlanItem } from "../classroom/lesson-api";
import { courseKeys } from "../courses/api";
import { progressKeys } from "../progress/api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import {
  getMistakes,
  getReview,
  mistakesKey,
  reviewKey,
  type MistakeCard,
} from "./api";
import { ReviewCardRunner } from "./review-card-runner";

const copy = t.review;
const viz = t.loopViz;
const dateFmt = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

export default function Review({ embedded = false }: { embedded?: boolean } = {}) {
  const courseId = useParams().courseId ?? "";
  const [params] = useSearchParams();
  const plan = params.get("plan");
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { tutor } = useActiveTutor();

  const [kpId, setKpId] = useState("");
  const [since, setSince] = useState("");
  const [archived, setArchived] = useState(false);
  const [redoCard, setRedoCard] = useState<MistakeCard | null>(null);

  const queue = useQuery({
    queryKey: reviewKey(courseId, null),
    queryFn: () => getReview(courseId, null),
    enabled: Boolean(courseId) && !plan,
  });

  // Unfiltered mistake list keeps KP filter options intact even after selecting a KP
  const allMistakes = useQuery({
    queryKey: mistakesKey(courseId, "", "", archived),
    queryFn: () => getMistakes(courseId, "", "", archived),
    enabled: Boolean(courseId) && !plan,
  });

  const mistakes = useQuery({
    queryKey: mistakesKey(courseId, kpId, since, archived),
    queryFn: () => getMistakes(courseId, kpId, since, archived),
    enabled: Boolean(courseId) && !plan,
  });

  const reteach = useMutation({
    mutationFn: (targetKpId: string) => createPointPlanItem(courseId, targetKpId),
    onSuccess: (created) => navigate(`/plan-items/${created.plan_item_id}/lesson`),
  });

  const kpOptions = useMemo(() => {
    const entries = new Map<string, string>();
    for (const card of allMistakes.data?.cards ?? []) {
      if (card.kp_id) entries.set(card.kp_id, card.kp_name || card.kp_id);
    }
    return [
      { value: "__all__", label: copy.all },
      ...Array.from(entries.entries()).map(([value, label]) => ({ value, label })),
    ];
  }, [allMistakes.data]);

  const groupedMistakes = useMemo(() => {
    const groups: Array<{ kpId: string | null; kpName: string; cards: MistakeCard[] }> = [];
    const map = new Map<string, { kpId: string | null; kpName: string; cards: MistakeCard[] }>();
    for (const card of mistakes.data?.cards ?? []) {
      const key = card.kp_id || "__none__";
      let group = map.get(key);
      if (!group) {
        group = { kpId: card.kp_id, kpName: card.kp_name || viz.ungroupedUnit, cards: [] };
        map.set(key, group);
        groups.push(group);
      }
      group.cards.push(card);
    }
    return groups;
  }, [mistakes.data]);

  if (plan) {
    return <Navigate to={`/plan-items/${encodeURIComponent(plan)}/lesson`} replace />;
  }

  const dueCount = queue.data?.cards.length ?? 0;

  return (
    <div className="grid min-w-0 gap-5" data-testid="review-page">
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

      {/* Due Review Hero Card */}
      <Card padding="lg" className="grid gap-4 shadow-1" data-testid="review-due-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption font-medium text-fg-tertiary">{viz.reviewDueHeading}</span>
          <Badge tone={dueCount > 0 ? "accent" : "neutral"}>
            {dueCount} {copy.cards}
          </Badge>
        </div>

        {queue.isPending ? (
          <Loading />
        ) : queue.isError ? (
          <Problem error={queue.error} onRetry={() => void queue.refetch()} />
        ) : dueCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="md" /> : null}
              <div className="grid gap-0.5">
                <h2 className="text-title font-semibold text-fg-primary">
                  {viz.reviewDueCount.replace("{count}", String(dueCount))}
                </h2>
                <p className="text-ui text-fg-secondary">{copy.lead}</p>
              </div>
            </div>
            <Link
              className="button primary"
              to={`/courses/${courseId}/review/session`}
              data-testid="start-review-session"
            >
              <Play size={15} aria-hidden="true" />
              <span>{viz.reviewStartSession}</span>
            </Link>
          </div>
        ) : (
          <EmptyState
            visual={tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="lg" /> : undefined}
            title={copy.empty}
            description={t.tutorsGallery.emptyReviewLine}
          />
        )}
      </Card>

      {/* Mistake Book grouped by KP */}
      <Card padding="lg" className="grid gap-4" data-testid="mistake-book">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <span className="text-caption text-fg-tertiary">{copy.history}</span>
            <h2 className="text-title font-semibold text-fg-primary">{copy.mistakes}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[160px]">
              <Select
                aria-label={copy.knowledgePoint}
                value={kpId || "__all__"}
                onValueChange={(next) => setKpId(next === "__all__" ? "" : next)}
                options={kpOptions}
              />
            </div>
            <label className="inline-flex items-center gap-2 text-caption text-fg-secondary">
              <span>{copy.since}</span>
              <input
                type="date"
                value={since}
                onChange={(event) => setSince(event.target.value)}
                className="min-h-10 rounded-md border border-line-default bg-surface-card px-2.5 text-ui text-fg-primary"
              />
            </label>
            <Checkbox
              label={copy.archived}
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
          </div>
        </div>

        {reteach.isError ? <Problem error={reteach.error} /> : null}
        {mistakes.isPending ? (
          <Loading />
        ) : mistakes.isError ? (
          <Problem error={mistakes.error} onRetry={() => void mistakes.refetch()} />
        ) : groupedMistakes.length === 0 ? (
          <p className="py-4 text-center text-ui text-fg-secondary">{viz.mistakeEmpty}</p>
        ) : (
          <div className="grid gap-5">
            {groupedMistakes.map((group) => (
              <section key={group.kpId ?? "__none__"} className="grid gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle pb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-body font-semibold text-fg-primary">{group.kpName}</h3>
                    <Badge tone="neutral">
                      {viz.mistakeGroupCount.replace("{count}", String(group.cards.length))}
                    </Badge>
                  </div>
                  {group.kpId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      pending={reteach.isPending && reteach.variables === group.kpId}
                      leftIcon={<RotateCcw size={14} aria-hidden="true" />}
                      onClick={() => reteach.mutate(group.kpId!)}
                    >
                      {viz.mistakeReteach}
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-3">
                  {group.cards.map((entry) => {
                    const verdictKey = entry.original_mistake?.verdict;
                    const verdictLabel = verdictKey
                      ? (t.classroom.verdicts[verdictKey as keyof typeof t.classroom.verdicts] ?? verdictKey)
                      : "";
                    const created = entry.original_mistake?.created_at
                      ? dateFmt.format(new Date(entry.original_mistake.created_at))
                      : "";
                    return (
                      <article
                        key={entry.id}
                        data-testid="mistake-item"
                        className="grid gap-2 rounded-md border border-line-subtle bg-surface-page p-3.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-fg-tertiary">
                          <div className="flex flex-wrap items-center gap-2">
                            {verdictLabel ? <Badge tone="retry">{verdictLabel}</Badge> : null}
                            {created ? <time>{created}</time> : null}
                          </div>
                        </div>
                        <p className="text-body font-medium text-fg-primary">
                          {entry.item?.stem || entry.front}
                        </p>
                        <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-fg-secondary">
                          <span>
                            {copy.original}：{String(entry.original_mistake?.detail.answer ?? copy.unknown)}
                          </span>
                          {entry.original_mistake?.detail.gap ? (
                            <span>
                              {copy.reason}：{entry.original_mistake.detail.gap}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {entry.item ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setRedoCard(entry)}
                            >
                              {viz.mistakeRedo}
                            </Button>
                          ) : null}
                          {entry.kp_id ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              pending={reteach.isPending && reteach.variables === entry.kp_id}
                              leftIcon={<RotateCcw size={14} aria-hidden="true" />}
                              onClick={() => reteach.mutate(entry.kp_id!)}
                            >
                              {viz.mistakeReteach}
                            </Button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>

      {/* Single-mistake Redo Dialog */}
      <Dialog
        open={Boolean(redoCard)}
        onOpenChange={(open) => {
          if (!open) setRedoCard(null);
        }}
        title={viz.mistakeRedoTitle}
        size="md"
      >
        {redoCard ? (
          <ReviewCardRunner
            key={redoCard.id}
            card={redoCard}
            nextLabel={t.connectWizard.done}
            onSettled={() => {
              void queries.invalidateQueries({ queryKey: ["courses", courseId, "mistakes"] });
              void queries.invalidateQueries({ queryKey: ["courses", courseId, "review"] });
              void queries.invalidateQueries({ queryKey: progressKeys.course(courseId) });
              void queries.invalidateQueries({ queryKey: courseKeys.dashboard });
            }}
            onAdvance={() => setRedoCard(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
