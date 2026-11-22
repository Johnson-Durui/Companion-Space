import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Loading, Problem } from "../../app/ui";
import { FocusShell } from "../../shell/FocusShell";
import { Badge, Card, EmptyState, SegmentProgress, TutorAvatar } from "../../ui";
import t from "../../locales/zh-CN.json";
import { courseKeys } from "../courses/api";
import { masteryLabel } from "../plan/why-sentence";
import { progressKeys } from "../progress/api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import { getReview, type ReviewCard } from "./api";
import { ReviewCardRunner, type ReviewOutcome } from "./review-card-runner";

const viz = t.loopViz;

function ReviewSessionDeck({
  courseId,
  cards,
}: {
  courseId: string;
  cards: ReviewCard[];
}) {
  const queries = useQueryClient();
  const { tutor } = useActiveTutor();
  const [cursor, setCursor] = useState(0);
  const [outcomes, setOutcomes] = useState<ReviewOutcome[]>([]);

  function handleSettled() {
    void queries.invalidateQueries({ queryKey: ["courses", courseId, "review"] });
    void queries.invalidateQueries({ queryKey: ["courses", courseId, "mistakes"] });
    void queries.invalidateQueries({ queryKey: progressKeys.course(courseId) });
    void queries.invalidateQueries({ queryKey: courseKeys.dashboard });
  }

  function handleAdvance(outcome: ReviewOutcome) {
    setOutcomes((prev) => [...prev, outcome]);
    setCursor((idx) => idx + 1);
  }

  const done = cursor >= cards.length;
  const currentCard = cards[cursor];

  if (done) {
    const correctCount = outcomes.filter((o) => o.verdict === "correct").length;
    const archivedCount = outcomes.filter((o) => o.archived).length;
    const masteryByKp = new Map<
      string,
      { name: string; before: number; after: number }
    >();
    for (const entry of outcomes) {
      if (!entry.kpId || !entry.kpName || !entry.beforeMastery || !entry.afterMastery) continue;
      if (entry.kind !== "item") continue;
      const existing = masteryByKp.get(entry.kpId);
      if (!existing) {
        masteryByKp.set(entry.kpId, {
          name: entry.kpName,
          before: entry.beforeMastery.probability,
          after: entry.afterMastery.probability,
        });
      } else {
        existing.after = entry.afterMastery.probability;
      }
    }
    const masteryChanges = Array.from(masteryByKp.entries());

    return (
      <Card padding="lg" className="grid gap-5 shadow-2" data-testid="review-summary">
        <div className="flex flex-wrap items-center gap-3.5">
          {tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="md" /> : null}
          <div className="grid gap-1">
            <h1 className="text-headline font-semibold text-fg-primary">{viz.reviewSummaryTitle}</h1>
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge tone="accent">{viz.reviewSummaryDone.replace("{count}", String(outcomes.length))}</Badge>
              {correctCount > 0 ? (
                <Badge tone="ok">{viz.reviewSummaryCorrect.replace("{count}", String(correctCount))}</Badge>
              ) : null}
              {archivedCount > 0 ? (
                <Badge tone="ok">{viz.reviewSummaryArchived.replace("{count}", String(archivedCount))}</Badge>
              ) : null}
            </div>
          </div>
        </div>

        {masteryChanges.length > 0 ? (
          <div className="grid gap-2 border-t border-line-subtle pt-4">
            <h2 className="text-ui font-semibold text-fg-secondary">{viz.reviewSummaryMastery}</h2>
            <ul className="grid gap-2">
              {masteryChanges.map(([kpId, entry]) => (
                <li
                  key={kpId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-page px-3.5 py-2 text-ui"
                >
                  <strong className="font-medium text-fg-primary">{entry.name}</strong>
                  <span className="tabular-nums text-fg-secondary">
                    {masteryLabel(entry.before)} ({Math.round(entry.before * 100)}%) →{" "}
                    {masteryLabel(entry.after)} ({Math.round(entry.after * 100)}%)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3 pt-2">
          <Link className="button primary" to="/">
            {t.app.backToday}
          </Link>
          <Link className="button quiet" to={`/courses/${courseId}/review`}>
            {viz.reviewBackCourse}
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-5" data-testid="review-session-active">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-fg-primary">{t.app.titles.reviewSession}</h1>
        <div className="flex items-center gap-3">
          <SegmentProgress
            current={cursor + 1}
            total={cards.length}
            label={t.app.titles.reviewSession}
          />
          <span className="text-caption tabular-nums font-medium text-fg-secondary">
            {viz.reviewProgress
              .replace("{current}", String(cursor + 1))
              .replace("{total}", String(cards.length))}
          </span>
        </div>
      </div>

      <Card padding="lg" className="shadow-2">
        <ReviewCardRunner
          key={currentCard.id}
          card={currentCard}
          nextLabel={cursor + 1 >= cards.length ? viz.reviewFinish : viz.reviewNextCard}
          onSettled={handleSettled}
          onAdvance={handleAdvance}
        />
      </Card>
    </div>
  );
}

export default function ReviewSessionPage() {
  const courseId = useParams().courseId ?? "";
  const { tutor } = useActiveTutor();

  const queue = useQuery({
    queryKey: ["review-session-snapshot", courseId],
    queryFn: () => getReview(courseId, null),
    enabled: Boolean(courseId),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  return (
    <FocusShell
      flowName={t.app.titles.reviewSession}
      exitTo={`/courses/${courseId}/review`}
      exitLabel={t.app.exit}
      maxWidth="md"
    >
      {queue.isPending ? (
        <Loading />
      ) : queue.isError ? (
        <Problem error={queue.error} onRetry={() => void queue.refetch()} />
      ) : !queue.data.cards.length ? (
        <Card padding="lg">
          <h1 className="sr-only">{t.app.titles.reviewSession}</h1>
          <EmptyState
            visual={tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="lg" /> : undefined}
            title={t.review.empty}
            description={t.tutorsGallery.emptyReviewLine}
            action={
              <Link className="button primary" to={`/courses/${courseId}`}>
                {viz.reviewBackCourse}
              </Link>
            }
          />
        </Card>
      ) : (
        <ReviewSessionDeck courseId={courseId} cards={queue.data.cards} />
      )}
    </FocusShell>
  );
}
