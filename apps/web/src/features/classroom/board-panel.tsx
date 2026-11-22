import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { LessonText } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import { Badge, Button, CheckCircle2, ChevronDown, Sparkles, XCircle } from "../../ui";
import type { Block } from "./board";
import { BoardBlock } from "./board-block";
import {
  INITIAL_BOARD_FOLLOW,
  isNearBottom,
  jumpToLatestFollow,
  updateFollowOnContent,
  updateFollowOnScroll,
} from "./board-follow";
import type { AnsweredCard, BoardDivider } from "./lesson-state";

const copy = t.classroom;

export function formatDividerText(divider: BoardDivider): string {
  if (divider.kind === "stage") {
    const stageName = copy.stages[divider.stage as keyof typeof copy.stages] ?? divider.stage ?? "";
    return stageName;
  }
  if (divider.kind === "reexplain") {
    const styleName =
      (divider.style && copy.styles[divider.style as keyof typeof copy.styles]) ||
      divider.style ||
      copy.styles.guided;
    return copy.adaptReexplain.replace("{style}", styleName);
  }
  if (divider.kind === "prereq") {
    return copy.adaptPrereq.replace("{kp}", divider.kpName ?? "");
  }
  return copy.adaptReturn;
}

export interface BoardPanelProps {
  title: string;
  stage: string;
  board: Block[];
  dividers: BoardDivider[];
  answeredCards: AnsweredCard[];
  activeBlockId?: string;
  trayOpen?: boolean;
  ready: boolean;
  reducedMotion: boolean;
  trayKey: string;
  onLocate: (target: string) => void;
}

export function BoardPanel({
  title,
  stage,
  board,
  dividers,
  answeredCards,
  activeBlockId,
  trayOpen = false,
  ready,
  reducedMotion,
  trayKey,
  onLocate,
}: BoardPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeBlockRef = useRef<HTMLDivElement>(null);
  const programmaticUntilRef = useRef(0);
  const [follow, setFollow] = useState(INITIAL_BOARD_FOLLOW);

  const totalItems = board.length + answeredCards.length + dividers.length;
  const effectiveFollow = updateFollowOnContent(follow, totalItems);
  const stageLabel = copy.stages[stage as keyof typeof copy.stages] ?? stage;

  const scrollToLatest = useCallback(
    (instant = false) => {
      const container = scrollRef.current;
      if (!container) return;
      programmaticUntilRef.current = performance.now() + 450;
      const behavior: ScrollBehavior = instant || reducedMotion ? "instant" : "smooth";
      if (activeBlockRef.current) {
        activeBlockRef.current.scrollIntoView({ block: "nearest", behavior });
      }
      container.scrollTo({ top: container.scrollHeight, behavior });
    },
    [reducedMotion],
  );

  useEffect(() => {
    if (!effectiveFollow.autoFollow || totalItems === 0) return;
    const raf = window.requestAnimationFrame(() => scrollToLatest(false));
    return () => window.cancelAnimationFrame(raf);
  }, [effectiveFollow.autoFollow, totalItems, activeBlockId, trayKey, scrollToLatest]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (performance.now() < programmaticUntilRef.current) return;
    const near = isNearBottom(container.scrollTop, container.clientHeight, container.scrollHeight);
    setFollow((prev) => {
      const synced = updateFollowOnContent(prev, totalItems);
      return updateFollowOnScroll(synced, near);
    });
  }, [totalItems]);

  const handleJumpLatest = useCallback(() => {
    setFollow(jumpToLatestFollow(totalItems));
    scrollToLatest(false);
  }, [scrollToLatest, totalItems]);

  const dividersAt = (blockCount: number) =>
    dividers.filter((divider) => divider.afterBlockCount === blockCount);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="lesson-board"
        aria-label={copy.board}
        className="cs-stage-board-scroll"
      >
        <div className="mx-auto grid w-full max-w-[780px] gap-4">
          {/* Opening cover (moves up as page header once blocks arrive) */}
          <header className="grid gap-1.5 border-b border-line-subtle pb-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption font-medium text-fg-tertiary">{copy.board}</span>
              <Badge tone="neutral">{stageLabel}</Badge>
            </div>
            <h2 className="text-title font-semibold text-fg-primary leading-snug">{title}</h2>
            {board.length === 0 ? (
              <p className="text-ui text-fg-secondary">{copy.openingHint}</p>
            ) : null}
          </header>

          {/* Dividers emitted before the first board block */}
          {dividersAt(0).map((divider) => (
            <DividerLine key={divider.id} divider={divider} />
          ))}

          {/* Board blocks interleaved with stage / adaptation dividers */}
          {board.map((block, index) => {
            const isActive = block.id === activeBlockId;
            return (
              <div key={block.id} className="grid gap-3">
                <div
                  ref={isActive ? activeBlockRef : undefined}
                  data-block-id={block.id}
                  data-active-block={isActive || undefined}
                  className={clsx(
                    "rounded-md px-3 py-2 transition-[background-color,border-color] duration-base ease-out",
                    isActive
                      ? "bg-board-focus border-l-[3px] border-l-accent"
                      : "border-l-[3px] border-l-transparent",
                  )}
                >
                  <BoardBlock
                    block={block}
                    locate={ready ? onLocate : undefined}
                  />
                </div>
                {dividersAt(index + 1).map((divider) => (
                  <DividerLine key={divider.id} divider={divider} />
                ))}
              </div>
            );
          })}

          {/* Answered question summary cards (visible once tray closes) */}
          {answeredCards.map((card, idx) => {
            if (trayOpen && idx === answeredCards.length - 1) return null;
            const isOk = card.verdict === "correct";
            const isLatest = idx === answeredCards.length - 1;
            const verdictLabel =
              copy.verdicts[card.verdict as keyof typeof copy.verdicts] ?? card.verdict;
            return (
              <article
                key={card.id}
                data-testid="answered-card"
                className="grid gap-2 rounded-md border border-line-default bg-surface-sunken/70 p-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-semibold text-fg-secondary">
                    {copy.question}
                  </span>
                  <Badge
                    tone={isOk ? "ok" : "retry"}
                    role={isLatest ? "status" : undefined}
                  >
                    {isOk ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                    <span>{verdictLabel}</span>
                  </Badge>
                </div>
                <div className="text-ui text-fg-primary line-clamp-2 [&>p]:m-0">
                  <LessonText source={card.stem} />
                </div>
                {card.studentAnswer ? (
                  <p className="text-caption text-fg-secondary">
                    {copy.answeredPrefix}
                    <strong className="font-medium text-fg-primary">{card.studentAnswer}</strong>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>

      {/* Floating "Back to latest" pill when user scrolled up */}
      {!effectiveFollow.autoFollow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-sticky flex justify-end px-4">
          <Button
            variant="primary"
            size="sm"
            data-testid="back-to-latest"
            leftIcon={<ChevronDown size={15} />}
            onClick={handleJumpLatest}
            className="pointer-events-auto shadow-2 rounded-pill"
          >
            {effectiveFollow.unreadCount > 0
              ? copy.backToLatestCount.replace("{count}", String(effectiveFollow.unreadCount))
              : copy.backToLatest}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DividerLine({ divider }: { divider: BoardDivider }) {
  const isAdapt = divider.kind !== "stage";
  const text = formatDividerText(divider);
  return (
    <div
      role="separator"
      data-divider-kind={divider.kind}
      className="flex items-center gap-3 py-1"
    >
      <span className="h-px flex-1 bg-line-subtle" />
      <span
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-caption font-medium",
          isAdapt
            ? "bg-accent-soft text-accent-strong border border-accent/25"
            : "bg-surface-sunken text-fg-secondary",
        )}
      >
        {isAdapt ? <Sparkles size={12} aria-hidden="true" /> : null}
        <span>{text}</span>
        {divider.repeat && divider.repeat > 1 ? (
          <span className="rounded-pill bg-surface-card px-1.5 py-0.5 text-micro text-fg-secondary">
            {copy.adaptRepeat.replace("{n}", String(divider.repeat))}
          </span>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-line-subtle" />
    </div>
  );
}
