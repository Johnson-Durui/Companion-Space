import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { LessonPhase } from "@companion-space/avatar-engine/types";
import { TutorVideoBox } from "@companion-space/avatar-engine/video-box";
import "@companion-space/avatar-engine/video-box.css";
import type { Character } from "../../app/api";
import { StageShell } from "../../shell/StageShell";
import {
  ArrowLeft,
  Badge,
  Button,
  Captions,
  CaptionsOff,
  Download,
  Pause,
  Play,
  Select,
  Slider,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import { boardMarkdown } from "../classroom/board";
import { BoardPanel } from "../classroom/board-panel";
import { restoreClassroom, type ClassroomState } from "../classroom/lesson-state";
import type { LessonEvent } from "../classroom/timeline";
import { buildReplayTimeline, formatMediaTime, indexAtTimeMs } from "./replay-timeline";

const SPEED_OPTIONS = [
  { value: "0.75", label: "0.75×" },
  { value: "1", label: "1×" },
  { value: "1.25", label: "1.25×" },
  { value: "1.5", label: "1.5×" },
  { value: "2", label: "2×" },
];

export interface ReplayStageProps {
  title: string;
  backTo: string;
  backLabel: string;
  events: readonly LessonEvent[];
  position: number;
  playing: boolean;
  speed: number;
  speaking?: boolean;
  teacher?: Character | null;
  topbarBadges?: ReactNode;
  dockExtra?: ReactNode;
  tray?: ReactNode;
  disablePlay?: boolean;
  onTogglePlay: () => void;
  onSeekPosition: (nextIndex: number) => void;
  onSpeedChange: (nextSpeed: number) => void;
  renderState?: (state: ClassroomState) => ReactNode;
}

export function ReplayStage({
  title,
  backTo,
  backLabel,
  events,
  position,
  playing,
  speed,
  speaking = false,
  teacher,
  topbarBadges,
  dockExtra,
  tray,
  disablePlay = false,
  onTogglePlay,
  onSeekPosition,
  onSpeedChange,
}: ReplayStageProps) {
  const [showCaption, setShowCaption] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const ordered = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const timeline = useMemo(
    () => buildReplayTimeline(ordered, teacher?.voice.rate),
    [ordered, teacher?.voice.rate],
  );
  const current = ordered[position - 1];
  const state = useMemo(
    () => restoreClassroom(ordered, current?.seq ?? 0),
    [ordered, current?.seq],
  );
  const finalBoard = useMemo(
    () => restoreClassroom(ordered, Infinity).boardPages.flatMap((page) => page.blocks),
    [ordered],
  );
  const currentMs = timeline.offsetsMs[Math.min(position, timeline.offsetsMs.length - 1)] ?? 0;

  const labels = useMemo(() => videoBoxLabels(), []);
  const teacherConfig = useMemo(
    () => (teacher ? toVideoAvatarConfig(teacher, reducedMotion) : null),
    [teacher, reducedMotion],
  );

  const phase: LessonPhase = tray
    ? "awaiting"
    : playing && (speaking || current?.type === "say")
      ? "speaking"
      : playing
        ? "thinking"
        : position === 0
          ? "lobby"
          : "paused";

  const statusLabel = tray
    ? t.classroom.waiting
    : phase === "speaking"
      ? t.classroom.speaking
      : phase === "lobby"
        ? t.classroom.waitingStart
        : t.classroom.paused;

  const resolvedPose = tray
    ? "listening_empathy"
    : phase === "speaking"
      ? state.avatar.pose === "board_guiding"
        ? "board_guiding"
        : "lecturing"
      : "idle_companion";

  function downloadBoard() {
    const url = URL.createObjectURL(
      new Blob([boardMarkdown(finalBoard)], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "lesson"}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const topbar = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Link
          to={backTo}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-card hover:text-fg-primary"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{backLabel}</span>
        </Link>
        <h1 className="truncate text-ui font-semibold text-fg-primary">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">{topbarBadges}</div>
    </>
  );

  const stageNode = (
    <div className="relative flex h-full min-h-0 flex-none items-center justify-center sm:flex-1 sm:w-full">
      {teacherConfig ? (
        <TutorVideoBox
          config={teacherConfig}
          pose={resolvedPose}
          phase={phase}
          emotion={state.avatar.emotion}
          gen={state.avatar.gen}
          statusLabel={statusLabel}
          caption={state.caption || t.history.emptyCaption}
          captionVisible={showCaption}
          showSoundBars={playing && speaking}
          stageMode
          labels={labels}
        />
      ) : (
        <div
          data-testid="tutor-video-box"
          className="flex h-full w-full flex-col justify-end rounded-lg border border-line-subtle bg-surface-card p-5"
        >
          {showCaption ? (
            <p className="text-body leading-relaxed text-fg-primary" aria-live="polite">
              {state.caption || t.history.emptyCaption}
            </p>
          ) : null}
          <p className="mt-3 flex items-center justify-between text-ui font-semibold text-fg-primary">
            <span>{t.classroom.teacher}</span>
            <Badge tone="neutral">{statusLabel}</Badge>
          </p>
        </div>
      )}
    </div>
  );

  const boardNode = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <BoardPanel
        title={title}
        stage={state.stage}
        board={[...state.board]}
        pages={state.boardPages}
        dividers={[...state.dividers]}
        answeredCards={[...state.answeredCards]}
        activeBlockId={state.activeBlockId}
        activePoint={state.activePoint}
        latestMarkSeq={state.latestMarkSeq}
        progressiveSteps={false}
        trayOpen={Boolean(tray)}
        ready={false}
        reducedMotion={reducedMotion}
        trayKey={`${Boolean(tray)}:${position}`}
        onLocate={() => {}}
      />
      {tray}
    </div>
  );

  const dockBtnBase =
    "min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-subtle bg-surface-card text-fg-primary text-caption font-medium transition-[background-color,border-color,color,transform] duration-fast ease-out hover:border-line-control hover:bg-surface-sunken active:not-disabled:scale-[0.97] disabled:opacity-45 disabled:cursor-not-allowed";

  const finished = ordered.length > 0 && position >= ordered.length;

  const dockNode = (
    <div className="flex h-full w-full items-center justify-between gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={disablePlay || !ordered.length}
          leftIcon={playing && !disablePlay ? <Pause size={16} /> : <Play size={16} />}
          onClick={onTogglePlay}
          className="min-h-11"
        >
          {finished ? t.sample.restart : playing && !disablePlay ? t.history.pause : t.history.play}
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          data-testid="replay-time-display"
          className="shrink-0 text-caption tabular-nums text-fg-secondary"
        >
          {formatMediaTime(currentMs)} / {formatMediaTime(timeline.totalMs)}
        </span>
        <div className="min-w-0 flex-1">
          <Slider
            value={currentMs}
            min={0}
            max={Math.max(1, timeline.totalMs)}
            step={Math.max(100, Math.round(timeline.totalMs / Math.max(1, ordered.length)))}
            disabled={!ordered.length}
            aria-label={t.history.position}
            onValueChange={(nextMs) => {
              onSeekPosition(indexAtTimeMs(timeline, nextMs));
            }}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <div className="hidden w-20 sm:block">
          <Select
            options={SPEED_OPTIONS}
            value={String(speed)}
            aria-label={t.classroom.speed}
            onValueChange={(next) => onSpeedChange(Number(next) || 1)}
          />
        </div>

        <button
          type="button"
          aria-label={t.classroom.toggleCaption}
          aria-pressed={showCaption}
          title={t.classroom.toggleCaption}
          onClick={() => setShowCaption((prev) => !prev)}
          className={`${dockBtnBase} hidden sm:inline-flex ${showCaption ? "border-accent text-accent-strong" : ""}`}
        >
          {showCaption ? <Captions size={18} aria-hidden="true" /> : <CaptionsOff size={18} aria-hidden="true" />}
        </button>

        <button
          type="button"
          disabled={!finalBoard.length}
          aria-label={t.history.exportBoard}
          title={t.history.exportBoard}
          onClick={downloadBoard}
          className={`${dockBtnBase} inline-flex px-2.5`}
        >
          <Download size={16} aria-hidden="true" />
          <span className="hidden md:inline">{t.history.exportBoard}</span>
        </button>

        {dockExtra}
      </div>
    </div>
  );

  return (
    <StageShell
      phase={phase}
      topbar={topbar}
      stage={stageNode}
      board={boardNode}
      dock={dockNode}
    />
  );
}
