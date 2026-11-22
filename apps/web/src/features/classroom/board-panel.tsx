import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { LessonText } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import {
  Badge,
  Button,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Dialog,
  Sparkles,
  XCircle,
} from "../../ui";
import type { Block, Page } from "./board";
import { BoardBlock } from "./board-block";
import {
  INITIAL_BOARD_FOLLOW,
  isNearBottom,
  jumpToLatestFollow,
  updateFollowOnContent,
  updateFollowOnScroll,
} from "./board-follow";
import type { AnsweredCard, BoardDivider, BoardPointTarget } from "./lesson-state";

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

export interface BoardOutlinePoint {
  kp_id: string;
  kp_name: string;
  text: string;
  seg_idx: number;
  kp_idx: number;
}

export interface BoardPanelProps {
  title: string;
  stage: string;
  estMinutes?: number | null;
  outline?: readonly BoardOutlinePoint[];
  board: Block[];
  pages?: readonly Page[];
  dividers: BoardDivider[];
  answeredCards: AnsweredCard[];
  activeBlockId?: string;
  activePoint?: BoardPointTarget;
  latestMarkSeq?: number;
  trayOpen?: boolean;
  ready: boolean;
  reducedMotion: boolean;
  trayKey: string;
  progressiveSteps?: boolean;
  showTools?: boolean;
  topBanner?: ReactNode;
  onLocate: (target: string) => void;
}

export function BoardPanel({
  title,
  stage,
  estMinutes,
  outline = [],
  board,
  pages,
  dividers,
  answeredCards,
  activeBlockId,
  activePoint,
  latestMarkSeq,
  trayOpen = false,
  ready,
  reducedMotion,
  trayKey,
  progressiveSteps = true,
  showTools = true,
  topBanner,
  onLocate,
}: BoardPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const programmaticUntilRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const [follow, setFollow] = useState(INITIAL_BOARD_FOLLOW);
  const [pinnedPageIndex, setPinnedPageIndex] = useState<number | null>(null);
  const [zoomBlock, setZoomBlock] = useState<Block | null>(null);

  const normalizedPages = useMemo<readonly Page[]>(() => {
    if (pages && pages.length > 0) return pages;
    return [{ id: "page-1", blocks: board }];
  }, [pages, board]);

  const latestPageIndex = Math.max(0, normalizedPages.length - 1);
  const activePageIndex =
    pinnedPageIndex !== null && pinnedPageIndex >= 0 && pinnedPageIndex <= latestPageIndex
      ? pinnedPageIndex
      : latestPageIndex;
  const isHistoricalPage = activePageIndex < latestPageIndex;
  const visibleBlocks = normalizedPages[activePageIndex]?.blocks ?? [];

  const pageDividers = useMemo(
    () => dividers.filter((divider) => (divider.pageIndex ?? latestPageIndex) === activePageIndex),
    [dividers, activePageIndex, latestPageIndex],
  );
  const pageAnsweredCards = useMemo(
    () => answeredCards.filter((card) => (card.pageIndex ?? latestPageIndex) === activePageIndex),
    [answeredCards, activePageIndex, latestPageIndex],
  );

  const totalItems = visibleBlocks.length + pageAnsweredCards.length + pageDividers.length;
  const effectiveFollow = updateFollowOnContent(follow, totalItems);
  const autoFollowRef = useRef(effectiveFollow.autoFollow);
  const stageLabel = copy.stages[stage as keyof typeof copy.stages] ?? stage;

  useEffect(() => {
    autoFollowRef.current = effectiveFollow.autoFollow;
  }, [effectiveFollow.autoFollow]);

  const scrollToLatest = useCallback(
    (instant = false) => {
      const container = scrollRef.current;
      if (!container) return;
      const behavior: ScrollBehavior = instant || reducedMotion ? "instant" : "smooth";
      programmaticUntilRef.current = behavior === "instant" ? 0 : performance.now() + 900;
      container.scrollTo({ top: container.scrollHeight, behavior });
      lastClientHeightRef.current = container.clientHeight;
      if (behavior === "instant") {
        lastScrollTopRef.current = container.scrollTop;
      }
    },
    [reducedMotion],
  );

  // Scroll targeted line or block into view when teacher points or marks a line
  useEffect(() => {
    if (isHistoricalPage || !activePoint?.blockId) return;
    const container = scrollRef.current;
    if (!container) return;
    const selector =
      activePoint.line !== undefined
        ? `[data-board-line="${CSS.escape(`${activePoint.blockId}.${activePoint.line}`)}"]`
        : `[data-block-id="${CSS.escape(activePoint.blockId)}"]`;
    const targetEl = container.querySelector<HTMLElement>(selector);
    if (!targetEl) return;
    const raf = window.requestAnimationFrame(() => {
      targetEl.scrollIntoView({
        block: "nearest",
        behavior: reducedMotion ? "instant" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activePoint, isHistoricalPage, reducedMotion]);

  // Keep latest / active content visible when board height shrinks (AnswerTray) OR content grows (progressive steps / async plots)
  useEffect(() => {
    const container = scrollRef.current;
    const content = contentRef.current;
    if (!container) return;
    lastClientHeightRef.current = container.clientHeight;
    if (content) lastContentHeightRef.current = content.offsetHeight;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const nextH = container.clientHeight;
      const nextContentH = content?.offsetHeight ?? lastContentHeightRef.current;
      const viewportChanged = nextH !== lastClientHeightRef.current;
      const contentGrew = nextContentH > lastContentHeightRef.current + 2;
      lastClientHeightRef.current = nextH;
      lastContentHeightRef.current = nextContentH;
      if ((viewportChanged || contentGrew) && autoFollowRef.current && !isHistoricalPage) {
        scrollToLatest(true);
      }
    });
    ro.observe(container);
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToLatest, isHistoricalPage]);

  useEffect(() => {
    if (isHistoricalPage || !effectiveFollow.autoFollow || totalItems === 0) return;
    const raf = window.requestAnimationFrame(() => scrollToLatest(false));
    return () => window.cancelAnimationFrame(raf);
  }, [isHistoricalPage, effectiveFollow.autoFollow, totalItems, activeBlockId, trayKey, scrollToLatest]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const curHeight = container.clientHeight;
    const curTop = container.scrollTop;
    const prevTop = lastScrollTopRef.current;
    if (curHeight !== lastClientHeightRef.current) {
      lastClientHeightRef.current = curHeight;
      if (autoFollowRef.current && !isHistoricalPage) {
        scrollToLatest(true);
      }
      return;
    }
    const near = isNearBottom(curTop, curHeight, container.scrollHeight);
    const scrolledUp = curTop < prevTop - 2;
    lastScrollTopRef.current = curTop;

    if (near) {
      programmaticUntilRef.current = 0;
      setFollow((prev) => {
        const synced = updateFollowOnContent(prev, totalItems);
        return updateFollowOnScroll(synced, true);
      });
      return;
    }

    if (scrolledUp) {
      programmaticUntilRef.current = 0;
      setFollow((prev) => {
        const synced = updateFollowOnContent(prev, totalItems);
        return updateFollowOnScroll(synced, false);
      });
    }
  }, [isHistoricalPage, scrollToLatest, totalItems]);

  const handleJumpLatest = useCallback(() => {
    setPinnedPageIndex(null);
    setFollow(jumpToLatestFollow(totalItems));
    scrollToLatest(false);
  }, [scrollToLatest, totalItems]);

  const goPage = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(latestPageIndex, nextIndex));
      setPinnedPageIndex(clamped === latestPageIndex ? null : clamped);
      if (clamped === latestPageIndex) {
        setFollow(jumpToLatestFollow(totalItems));
      } else {
        scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion ? "instant" : "smooth" });
      }
    },
    [latestPageIndex, reducedMotion, totalItems],
  );

  const dividersAt = (blockCount: number) =>
    pageDividers.filter((divider) => divider.afterBlockCount === blockCount);

  const showOpeningCover =
    activePageIndex === 0 && visibleBlocks.length === 0 && normalizedPages.length === 1;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {topBanner}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="lesson-board"
        aria-label={copy.board}
        className="cs-stage-board-scroll"
      >
        <div ref={contentRef} className="mx-auto grid w-full max-w-[780px] gap-4">
          {/* Opening cover (moves up as page header once blocks arrive) */}
          <header
            data-testid="board-cover"
            className={clsx(
              "grid gap-2 border-b border-line-subtle",
              showOpeningCover ? "py-6" : "pb-3",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-caption font-medium text-fg-tertiary">{copy.board}</span>
                {estMinutes ? (
                  <span className="text-caption tabular-nums text-fg-tertiary">
                    · {copy.estMinutes.replace("{min}", String(estMinutes))}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {normalizedPages.length > 1 ? (
                  <nav
                    aria-label={copy.board}
                    data-testid="board-pagination"
                    className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-sunken px-1.5 py-0.5 text-caption"
                  >
                    <button
                      type="button"
                      disabled={activePageIndex <= 0}
                      aria-label={copy.boardPrevPage}
                      onClick={() => goPage(activePageIndex - 1)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-card hover:text-fg-primary disabled:opacity-35"
                    >
                      <ChevronLeft size={14} aria-hidden="true" />
                    </button>
                    <span className="px-1.5 tabular-nums font-medium text-fg-primary">
                      {copy.boardPageOf
                        .replace("{current}", String(activePageIndex + 1))
                        .replace("{total}", String(normalizedPages.length))}
                    </span>
                    <button
                      type="button"
                      disabled={activePageIndex >= latestPageIndex}
                      aria-label={copy.boardNextPage}
                      onClick={() => goPage(activePageIndex + 1)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-card hover:text-fg-primary disabled:opacity-35"
                    >
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </nav>
                ) : null}
                <Badge tone="neutral">{stageLabel}</Badge>
              </div>
            </div>
            <h2
              className={clsx(
                "font-semibold leading-snug text-fg-primary",
                showOpeningCover ? "text-display" : "text-title",
              )}
            >
              {title}
            </h2>
            {showOpeningCover && outline.length > 0 ? (
              <div className="mt-2 grid gap-1.5 rounded-md border border-line-subtle bg-surface-sunken/60 p-3.5">
                <p className="text-caption font-semibold text-fg-secondary">{copy.outlineHeading}</p>
                <ol className="m-0 grid gap-1 pl-4 text-ui text-fg-primary">
                  {outline.map((point, idx) => (
                    <li key={`${point.seg_idx}-${point.kp_idx}-${idx}`} className="leading-relaxed">
                      <span>{point.text}</span>
                      {point.kp_name && point.kp_name !== point.text ? (
                        <span className="ml-1.5 text-caption text-fg-tertiary">({point.kp_name})</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : showOpeningCover ? (
              <p className="text-ui text-fg-secondary">{copy.openingHint}</p>
            ) : null}
          </header>

          {/* Dividers emitted before the first board block */}
          {dividersAt(0).map((divider) => (
            <DividerLine key={divider.id} divider={divider} />
          ))}

          {/* Board blocks interleaved with stage / adaptation dividers */}
          {visibleBlocks.map((block, index) => {
            const isActive = !isHistoricalPage && block.id === activeBlockId;
            return (
              <div key={block.id} className="grid gap-3">
                <div
                  data-block-id={block.id}
                  data-active-block={isActive || undefined}
                  className={clsx(
                    "rounded-md px-3 py-2 transition-[background-color,border-color] duration-base ease-out",
                    isActive
                      ? "border-l-[3px] border-l-accent bg-board-focus"
                      : "border-l-[3px] border-l-transparent",
                  )}
                >
                  <BoardBlock
                    block={block}
                    locate={ready && !isHistoricalPage ? onLocate : undefined}
                    latestMarkSeq={latestMarkSeq}
                    isActiveBlock={isActive}
                    progressiveSteps={progressiveSteps && !isHistoricalPage}
                    reducedMotion={reducedMotion}
                    showTools={showTools}
                    onZoom={setZoomBlock}
                  />
                </div>
                {dividersAt(index + 1).map((divider) => (
                  <DividerLine key={divider.id} divider={divider} />
                ))}
              </div>
            );
          })}

          {/* Answered question summary cards (visible once tray closes) */}
          {pageAnsweredCards.map((card, idx) => {
            if (!isHistoricalPage && trayOpen && idx === pageAnsweredCards.length - 1) return null;
            const isOk = card.verdict === "correct";
            const isLatest = !isHistoricalPage && idx === pageAnsweredCards.length - 1;
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
                <div className="line-clamp-2 text-ui text-fg-primary [&>p]:m-0">
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

      {/* Floating "Back to latest" or "Jump to latest page" pill */}
      {isHistoricalPage ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-sticky flex justify-end px-4">
          <Button
            variant="primary"
            size="sm"
            data-testid="jump-latest-page"
            leftIcon={<ChevronRight size={15} />}
            onClick={handleJumpLatest}
            className="pointer-events-auto rounded-pill shadow-2"
          >
            {copy.boardJumpLatestPage}
          </Button>
        </div>
      ) : !effectiveFollow.autoFollow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-sticky flex justify-end px-4">
          <Button
            variant="primary"
            size="sm"
            data-testid="back-to-latest"
            leftIcon={<ChevronDown size={15} />}
            onClick={handleJumpLatest}
            className="pointer-events-auto rounded-pill shadow-2"
          >
            {effectiveFollow.unreadCount > 0
              ? copy.backToLatestCount.replace("{count}", String(effectiveFollow.unreadCount))
              : copy.backToLatest}
          </Button>
        </div>
      ) : null}

      {/* Lightbox Dialog for zoomed plots, diagrams, and material images */}
      <Dialog
        open={Boolean(zoomBlock)}
        onOpenChange={(open) => {
          if (!open) setZoomBlock(null);
        }}
        title={zoomBlock?.title || copy.boardLightboxTitle}
        size="lg"
        closeLabel={copy.close}
      >
        {zoomBlock ? (
          <div data-testid="board-lightbox" data-surface="paper" className="rounded-md bg-surface-page p-4">
            <BoardBlock
              block={zoomBlock}
              reducedMotion={reducedMotion}
              progressiveSteps={false}
              showTools={false}
            />
          </div>
        ) : null}
      </Dialog>
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
            ? "border border-accent/25 bg-accent-soft text-accent-strong"
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
