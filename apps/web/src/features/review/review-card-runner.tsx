import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Problem } from "../../app/ui";
import {
  ArrowRight,
  Badge,
  Button,
  CheckCircle2,
  ChoiceCardGroup,
  Sparkles,
  TextInput,
  XCircle,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { masteryLabel } from "../plan/why-sentence";
import {
  answerCard,
  rateCard,
  type MasterySnapshot,
  type ReviewCard,
} from "./api";

const copy = t.review;
const viz = t.loopViz;

export interface ReviewOutcome {
  cardId: string;
  kind: "flashcard" | "item";
  verdict: "correct" | "incorrect" | "dont_know" | "rated";
  rating?: string;
  answer?: unknown;
  solution?: string;
  dueAt: string;
  archived: boolean;
  kpId?: string | null;
  kpName?: string | null;
  beforeMastery?: MasterySnapshot | null;
  afterMastery?: MasterySnapshot | null;
}

export function formatNextReviewDue(dueAt: string, now = new Date()): string {
  const target = Date.parse(dueAt);
  if (!Number.isFinite(target)) return viz.reviewNextDueToday;
  const diffMs = target - now.getTime();
  const days = Math.round(diffMs / 86_400_000);
  if (days <= 0) return viz.reviewNextDueToday;
  if (days === 1) return viz.reviewNextDueTomorrow;
  return viz.reviewNextDueDays.replace("{days}", String(days));
}

function cardOptions(card: ReviewCard) {
  const raw = card.item?.options;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : Object.entries(raw).map(([key, text]) => ({ key, text }));
}

export interface ReviewCardRunnerProps {
  card: ReviewCard;
  nextLabel?: string;
  onSettled?: (outcome: ReviewOutcome) => void;
  onAdvance: (outcome: ReviewOutcome) => void;
}

export function ReviewCardRunner({
  card,
  nextLabel,
  onSettled,
  onAdvance,
}: ReviewCardRunnerProps) {
  const [revealed, setRevealed] = useState(false);
  const [choice, setChoice] = useState("");
  const [multiChoice, setMultiChoice] = useState<string[]>([]);
  const [textAnswer, setTextAnswer] = useState("");
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);

  const opts = cardOptions(card);
  const isMulti = card.item?.type === "multi";

  const rate = useMutation({
    mutationFn: (rating: string) => rateCard(card.id, rating),
    onSuccess: (res, rating) => {
      const next: ReviewOutcome = {
        cardId: card.id,
        kind: "flashcard",
        verdict: "rated",
        rating,
        solution: card.back,
        dueAt: res.due_at,
        archived: res.state === "archived",
        kpId: res.kp_id ?? card.kp_id,
        kpName: res.kp_name ?? card.kp_name,
        beforeMastery: res.before_mastery,
        afterMastery: res.mastery,
      };
      setOutcome(next);
      onSettled?.(next);
    },
  });

  const answer = useMutation({
    mutationFn: ({ value, dontKnow }: { value: unknown; dontKnow?: boolean }) =>
      answerCard(card.id, value, dontKnow),
    onSuccess: (res) => {
      const verdict: ReviewOutcome["verdict"] =
        res.verdict === "correct"
          ? "correct"
          : res.verdict === "dont_know"
            ? "dont_know"
            : "incorrect";
      const next: ReviewOutcome = {
        cardId: card.id,
        kind: "item",
        verdict,
        rating: res.rating,
        answer: res.answer,
        solution: res.solution,
        dueAt: res.due_at,
        archived: res.state === "archived",
        kpId: res.kp_id ?? card.kp_id,
        kpName: res.kp_name ?? card.kp_name,
        beforeMastery: res.before_mastery,
        afterMastery: res.mastery,
      };
      setOutcome(next);
      onSettled?.(next);
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (outcome) return;
    const val = opts.length ? (isMulti ? multiChoice : choice) : textAnswer.trim();
    if (!val || (Array.isArray(val) && val.length === 0)) return;
    answer.mutate({ value: val, dontKnow: false });
  }

  const isCorrect = outcome?.verdict === "correct";
  const isRated = outcome?.verdict === "rated";
  const showMasteryDelta = Boolean(
    outcome?.kpName && outcome.beforeMastery && outcome.afterMastery && outcome.kind === "item",
  );

  return (
    <div className="grid gap-4" data-testid="review-card-runner" data-state={outcome ? "feedback" : "answering"}>
      {card.kp_name ? (
        <div>
          <Badge tone="neutral">{card.kp_name}</Badge>
        </div>
      ) : null}

      {card.kind === "flashcard" ? (
        <div className="grid gap-4">
          <h2 className="text-title font-semibold text-fg-primary">{card.front}</h2>
          {!outcome ? (
            revealed ? (
              <div className="grid gap-4 rounded-md bg-surface-sunken/70 p-4">
                <p className="text-body text-fg-primary">{card.back}</p>
                <div className="flex flex-wrap gap-2">
                  {(["again", "hard", "good", "easy"] as const).map((rating) => (
                    <Button
                      key={rating}
                      variant="secondary"
                      size="sm"
                      pending={rate.isPending && rate.variables === rating}
                      disabled={rate.isPending}
                      onClick={() => rate.mutate(rating)}
                    >
                      {copy.ratings[rating]}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <Button variant="primary" onClick={() => setRevealed(true)}>
                  {copy.reveal}
                </Button>
              </div>
            )
          ) : null}
          {rate.isError ? <Problem error={rate.error} /> : null}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="grid gap-4">
          <h2 className="text-title font-semibold text-fg-primary">
            {card.item?.stem || card.front}
          </h2>
          {opts.length > 0 ? (
            <ChoiceCardGroup
              options={opts}
              mode={isMulti ? "multi" : "single"}
              value={isMulti ? multiChoice : choice}
              disabled={answer.isPending || Boolean(outcome)}
              outcomes={
                outcome
                  ? Object.fromEntries(
                      (isMulti ? multiChoice : choice ? [choice] : []).map((key) => [
                        key,
                        outcome.verdict === "correct" ? ("correct" as const) : ("retry" as const),
                      ]),
                    )
                  : undefined
              }
              label={copy.answer}
              onChange={(next) => {
                if (outcome) return;
                if (isMulti) setMultiChoice(Array.isArray(next) ? next : [next]);
                else setChoice(Array.isArray(next) ? (next[0] ?? "") : next);
              }}
            />
          ) : (
            <TextInput
              value={textAnswer}
              disabled={answer.isPending || Boolean(outcome)}
              aria-label={copy.answer}
              onChange={(event) => setTextAnswer(event.target.value)}
            />
          )}

          {!outcome ? (
            <div className="flex flex-wrap gap-2.5">
              <Button
                type="submit"
                variant="primary"
                pending={answer.isPending}
                disabled={
                  opts.length > 0
                    ? isMulti
                      ? multiChoice.length === 0
                      : !choice
                    : !textAnswer.trim()
                }
              >
                {copy.submit}
              </Button>
              <Button
                variant="ghost"
                disabled={answer.isPending}
                onClick={() => answer.mutate({ value: null, dontKnow: true })}
              >
                {copy.dontKnow}
              </Button>
            </div>
          ) : null}
          {answer.isError ? <Problem error={answer.error} /> : null}
        </form>
      )}

      {/* I14: Post-answer feedback pause — stays visible until user clicks Next */}
      {outcome ? (
        <div
          data-testid="review-feedback"
          role="status"
          aria-live="polite"
          className="grid gap-3 rounded-lg border border-line-default bg-surface-page p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={isCorrect ? "ok" : isRated ? "accent" : "retry"}>
              {isCorrect ? <CheckCircle2 size={13} aria-hidden="true" /> : isRated ? null : <XCircle size={13} aria-hidden="true" />}
              <span>
                {isCorrect
                  ? viz.reviewCorrect
                  : outcome.verdict === "dont_know"
                    ? viz.reviewDontKnow
                    : isRated
                      ? `${viz.reviewRated} · ${copy.ratings[outcome.rating as keyof typeof copy.ratings] ?? outcome.rating ?? ""}`
                      : viz.reviewIncorrect}
              </span>
            </Badge>
            <span className="text-caption font-medium text-fg-secondary">
              {formatNextReviewDue(outcome.dueAt)}
            </span>
          </div>

          {outcome.answer !== undefined && outcome.answer !== null && String(outcome.answer).trim() ? (
            <p className="text-ui text-fg-primary">
              <strong className="font-semibold">{viz.reviewCorrectAnswer}：</strong>
              <span>{Array.isArray(outcome.answer) ? outcome.answer.join(", ") : String(outcome.answer)}</span>
            </p>
          ) : null}

          {outcome.solution ? (
            <p className="text-ui text-fg-secondary">
              <strong className="font-medium text-fg-primary">{viz.reviewSolution}：</strong>
              <span>{outcome.solution}</span>
            </p>
          ) : null}

          {showMasteryDelta && outcome.beforeMastery && outcome.afterMastery ? (
            <p className="text-caption tabular-nums text-fg-secondary" data-testid="review-mastery-delta">
              {viz.reviewMasteryDelta
                .replace("{name}", outcome.kpName ?? "")
                .replace(
                  "{before}",
                  `${masteryLabel(outcome.beforeMastery.probability)} (${Math.round(outcome.beforeMastery.probability * 100)}%)`,
                )
                .replace(
                  "{after}",
                  `${masteryLabel(outcome.afterMastery.probability)} (${Math.round(outcome.afterMastery.probability * 100)}%)`,
                )}
            </p>
          ) : null}

          {outcome.archived ? (
            <div className="flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-ui font-medium text-ok-text">
              <Sparkles size={15} aria-hidden="true" />
              <span>{viz.reviewArchivedToast}</span>
            </div>
          ) : null}

          <div className="pt-1">
            <Button
              variant="primary"
              data-testid="review-next-btn"
              rightIcon={<ArrowRight size={15} aria-hidden="true" />}
              onClick={() => onAdvance(outcome)}
            >
              {nextLabel || viz.reviewNextCard}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
