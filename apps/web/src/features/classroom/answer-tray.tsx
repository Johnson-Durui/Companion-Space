import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { LessonText } from "@companion-space/board";
import type { LessonPhase } from "@companion-space/avatar-engine/types";
import t from "../../locales/zh-CN.json";
import {
  AlertCircle,
  Badge,
  Button,
  CheckCircle2,
  ChoiceCardGroup,
  type ChoiceCardOutcome,
  Textarea,
} from "../../ui";
import type { Ask, Prefill } from "./lesson-state";

const copy = t.classroom;

export interface AnswerTrayProps {
  ask: Ask;
  askSeq?: number;
  prefill?: Prefill;
  phase: LessonPhase;
  verdict?: string;
  revealedAnswer?: string;
  judgingTimedOut?: boolean;
  onActivity: () => void;
  onSubmit: (value: string | string[], via: "text" | "voice" | "control", dontKnow?: boolean) => void;
  onAck: (value: "continue" | "easier" | "end") => void;
  onQuick: (kind: "hint" | "show_answer") => void;
  onFocusComposer: () => void;
}

export function AnswerTray({
  ask,
  prefill,
  phase,
  verdict,
  revealedAnswer,
  judgingTimedOut = false,
  onActivity,
  onSubmit,
  onAck,
  onQuick,
  onFocusComposer,
}: AnswerTrayProps) {
  const widget = ask.widget;
  const isJudging = phase === "judging";
  const isFeedback = phase === "feedback";
  const isLocked = isJudging || isFeedback;

  const [edited, setEdited] = useState<string | string[]>();
  const [stemExpanded, setStemExpanded] = useState(false);
  const [showScrollFade, setShowScrollFade] = useState(false);
  const optionsScrollRef = useRef<HTMLDivElement>(null);

  const value = useMemo(
    () => edited ?? prefill?.value ?? (widget?.type === "multi" ? [] : ""),
    [edited, prefill?.value, widget?.type],
  );
  const via: "text" | "voice" | "control" = edited === undefined && prefill ? prefill.via : "control";
  const hasSelection = Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  const stemText = widget?.stem ?? "";
  const isLongStem = stemText.length > 72 || stemText.includes("\n");

  useEffect(() => {
    const el = optionsScrollRef.current;
    if (!el) return;
    const updateFade = () => {
      setShowScrollFade(el.scrollHeight - (el.scrollTop + el.clientHeight) > 8);
    };
    updateFade();
    el.addEventListener("scroll", updateFade, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateFade) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", updateFade);
      ro?.disconnect();
    };
  }, [widget?.options.length, stemExpanded]);

  // Keyboard selection (A-H / 1-9) and Enter submission when tray is active
  useEffect(() => {
    if (!widget || !widget.options.length || isLocked) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }

      const key = event.key;
      if (key === "Enter" && hasSelection) {
        // Don't hijack Enter if user explicitly focused another button (e.g. "dontKnow")
        if (tag === "button" && !target?.hasAttribute("data-choice-key")) return;
        event.preventDefault();
        onActivity();
        onSubmit(value, via);
        return;
      }

      let matchedKey: string | undefined;
      if (/^[1-9]$/.test(key)) {
        const idx = Number(key) - 1;
        matchedKey = widget.options[idx]?.key;
      } else if (/^[a-hA-H]$/.test(key)) {
        const upper = key.toUpperCase();
        matchedKey = widget.options.find((opt) => opt.key.toUpperCase() === upper)?.key;
      }
      if (!matchedKey) return;

      event.preventDefault();
      onActivity();
      if (widget.type === "multi") {
        const current = Array.isArray(value) ? value : [];
        const next = current.includes(matchedKey)
          ? current.filter((item) => item !== matchedKey)
          : [...current, matchedKey];
        setEdited(next);
      } else {
        setEdited(matchedKey);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [widget, isLocked, hasSelection, value, via, onActivity, onSubmit]);

  const outcomes = useMemo<Record<string, ChoiceCardOutcome> | undefined>(() => {
    if (!verdict || !widget?.options.length) return undefined;
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    const map: Record<string, ChoiceCardOutcome> = {};
    const outcome: ChoiceCardOutcome =
      verdict === "correct"
        ? "correct"
        : verdict === "incorrect" || verdict === "partial"
          ? "retry"
          : null;
    if (outcome) {
      for (const k of selected) map[k] = outcome;
    }
    return map;
  }, [verdict, value, widget]);

  const choiceOptions = useMemo(
    () =>
      (widget?.options ?? []).map((option) => ({
        key: option.key,
        text: option.text,
        content: <LessonText source={option.text} />,
      })),
    [widget],
  );

  // Ack question tray
  if (ask.kind === "ack") {
    return (
      <section
        data-surface="paper"
        data-testid="answer-tray"
        aria-label={copy.question}
        className="cs-stage-tray cs-tray-enter"
      >
        <div className="px-4 py-3 border-b border-line-subtle flex items-center justify-between">
          <span className="text-ui font-semibold text-fg-primary">{copy.yourTurn}</span>
        </div>
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {(["continue", "easier", "end"] as const).map((item, idx) => (
            <Button
              key={item}
              variant={idx === 0 ? "primary" : "secondary"}
              disabled={isLocked}
              onClick={() => {
                onActivity();
                onAck(item);
              }}
            >
              {copy.ack[item]}
            </Button>
          ))}
        </div>
      </section>
    );
  }

  // Open-ended question (no widget)
  if (!widget) {
    return (
      <section
        data-surface="paper"
        data-testid="answer-tray"
        aria-label={copy.question}
        className="cs-stage-tray cs-tray-enter"
      >
        <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge tone="accent">{copy.yourTurn}</Badge>
            <p className="text-ui text-fg-primary">{copy.openQuestionHint}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onFocusComposer}>
            {copy.answer}
          </Button>
        </div>
        {verdict ? <VerdictBanner verdict={verdict} /> : null}
      </section>
    );
  }

  const submitForm = () => {
    if (isLocked || !hasSelection) return;
    onActivity();
    onSubmit(value, via);
  };

  return (
    <section
      data-surface="paper"
      data-testid="answer-tray"
      aria-label={copy.question}
      className="cs-stage-tray cs-tray-enter"
    >
      {/* Part 1: Sticky stem header */}
      <div className="grid gap-1.5 border-b border-line-subtle px-4 py-2.5 bg-surface-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption font-semibold text-accent-strong">{copy.question}</span>
          {isLongStem ? (
            <button
              type="button"
              onClick={() => setStemExpanded((prev) => !prev)}
              className="text-caption font-medium text-fg-secondary hover:text-fg-primary underline-offset-2 hover:underline"
            >
              {stemExpanded ? copy.collapseStem : copy.expandStem}
            </button>
          ) : null}
        </div>
        <div
          className={clsx(
            "text-ui font-medium text-fg-primary leading-snug [&>p]:m-0",
            !stemExpanded && "line-clamp-3",
            stemExpanded && "max-h-32 overflow-y-auto",
          )}
        >
          <LessonText source={widget.stem} />
        </div>
        {via === "voice" || via === "text" ? (
          <p className="text-caption text-info-text bg-info-soft rounded-sm px-2.5 py-1" role="status">
            {copy.confirmPrefill}
          </p>
        ) : null}
        {revealedAnswer ? (
          <div className="grid gap-0.5 rounded-sm bg-warn-soft px-2.5 py-1.5 text-caption text-warn-text" role="status">
            <p className="font-semibold">
              {copy.revealedAnswerPrefix}
              {revealedAnswer}
            </p>
            <p>{copy.showAnswerRule}</p>
          </div>
        ) : null}
      </div>

      {/* Part 2: Scrollable options or free-text answer */}
      <div className="relative min-h-0 overflow-hidden">
        <div
          ref={optionsScrollRef}
          data-testid="answer-tray-options"
          className="h-full max-h-full overflow-y-auto px-4 py-2.5"
        >
          {choiceOptions.length > 0 ? (
            <ChoiceCardGroup
              options={choiceOptions}
              mode={widget.type === "multi" ? "multi" : "single"}
              value={value}
              disabled={isLocked}
              outcomes={outcomes}
              label={copy.question}
              onChange={(next) => {
                onActivity();
                setEdited(next);
              }}
            />
          ) : (
            <Textarea
              aria-label={copy.answer}
              rows={2}
              maxLength={3000}
              disabled={isLocked}
              value={String(value)}
              onFocus={onActivity}
              onChange={(event) => {
                onActivity();
                setEdited(event.target.value);
              }}
            />
          )}
        </div>
        {showScrollFade ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface-card to-transparent"
          />
        ) : null}
      </div>

      {/* Part 3: Sticky action footer */}
      <div
        data-testid="answer-tray-footer"
        className="grid gap-2 border-t border-line-subtle bg-surface-card px-4 py-2.5"
      >
        {verdict ? <VerdictBanner verdict={verdict} /> : null}
        {judgingTimedOut && !verdict ? (
          <p className="text-caption text-warn-text bg-warn-soft rounded-sm px-2.5 py-1" role="status">
            {copy.judgingTimeout}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              pending={isJudging}
              disabled={isLocked || !hasSelection}
              onClick={submitForm}
            >
              {isJudging ? copy.judgingButton : copy.submitAnswer}
            </Button>
            <Button
              variant="secondary"
              disabled={isLocked}
              onClick={() => {
                onActivity();
                onSubmit("", "control", true);
              }}
            >
              {copy.dontKnow}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={isLocked}
              onClick={() => {
                onActivity();
                onQuick("hint");
              }}
            >
              {copy.quick.hint}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isLocked}
              title={copy.showAnswerRule}
              onClick={() => {
                onActivity();
                onQuick("show_answer");
              }}
            >
              {copy.quick.show_answer}
            </Button>
          </div>
        </div>
        <p className="text-micro text-fg-tertiary">{copy.showAnswerRule}</p>
      </div>
    </section>
  );
}

function VerdictBanner({ verdict }: { verdict: string }) {
  const isOk = verdict === "correct";
  const label = copy.verdicts[verdict as keyof typeof copy.verdicts] ?? verdict;
  return (
    <div
      role="status"
      data-verdict={verdict}
      className={clsx(
        "flex items-center gap-2 rounded-sm px-3 py-1.5 text-ui font-medium",
        isOk ? "bg-ok-soft text-ok-text" : "bg-retry-soft text-retry-text",
      )}
    >
      {isOk ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
      <span>{label}</span>
    </div>
  );
}
