import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { LessonPhase } from "@companion-space/avatar-engine/types";
import { Toaster, TooltipProvider } from "../ui";
import "./stage-shell.css";

export type StageViewMode = "split" | "board-first";
export type StageMobileView = "teacher" | "board";

export interface StageShellProps {
  phase: LessonPhase;
  topbar: ReactNode;
  stage: ReactNode;
  board: ReactNode;
  dock: ReactNode;
  transcript?: ReactNode;
  transcriptDocked?: boolean;
  viewMode?: StageViewMode;
  mobileView?: StageMobileView;
  trayOpen?: boolean;
  textMode?: boolean;
  className?: string;
}

export function StageShell({
  phase,
  topbar,
  stage,
  board,
  dock,
  transcript,
  transcriptDocked = false,
  viewMode = "split",
  mobileView = "teacher",
  trayOpen = false,
  textMode = false,
  className,
}: StageShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [pipOffset, setPipOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = meta?.content;
    if (meta) meta.content = "#0E1116";
    return () => {
      if (meta && previous) meta.content = previous;
    };
  }, []);

  // Reset offset lazily when not in board-first mode (zero setState-in-effect)
  const effectiveOffset = viewMode === "board-first" ? pipOffset : { x: 0, y: 0 };

  const onPipPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (viewMode !== "board-first" || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, select")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: effectiveOffset.x,
      origY: effectiveOffset.y,
    };
  };

  const onPipPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || viewMode !== "board-first") return;
    const container = mainRef.current;
    const maxX = Math.max(0, (container?.clientWidth ?? 900) - 200);
    const maxY = Math.max(0, (container?.clientHeight ?? 600) - 310);
    const nextX = Math.max(0, Math.min(maxX, drag.origX + (event.clientX - drag.startX)));
    const nextY = Math.max(0, Math.min(maxY, drag.origY + (event.clientY - drag.startY)));
    setPipOffset({ x: nextX, y: nextY });
  };

  const onPipPointerUp = () => {
    dragRef.current = null;
  };

  const stageStyle: CSSProperties | undefined =
    viewMode === "board-first" && (effectiveOffset.x !== 0 || effectiveOffset.y !== 0)
      ? { transform: `translate3d(${effectiveOffset.x}px, ${effectiveOffset.y}px, 0)` }
      : undefined;

  return (
    <TooltipProvider>
      <div
        className={className ? `cs-stage-shell ${className}` : "cs-stage-shell"}
        data-surface="stage"
        data-phase={phase}
        data-view-mode={viewMode}
        data-mobile-view={mobileView}
        data-tray-open={trayOpen ? "true" : "false"}
        data-testid="classroom-stage-shell"
      >
        <header className="cs-stage-topbar">{topbar}</header>
        <main
          ref={mainRef}
          id="main"
          className="cs-stage-main"
          data-transcript-docked={transcript && transcriptDocked ? "true" : undefined}
        >
          <aside
            className="cs-stage-left"
            data-testid="lesson-stage"
            data-text-mode={textMode ? "true" : undefined}
            style={stageStyle}
            onPointerDown={onPipPointerDown}
            onPointerMove={onPipPointerMove}
            onPointerUp={onPipPointerUp}
            onPointerCancel={onPipPointerUp}
          >
            {stage}
          </aside>
          <section
            className="cs-stage-right cs-board-paper"
            data-surface="paper"
            aria-label="白板与作答区"
          >
            {board}
          </section>
          {transcript && transcriptDocked ? (
            <aside
              className="cs-stage-transcript"
              data-testid="stage-transcript-column"
              aria-label="对话记录"
            >
              {transcript}
            </aside>
          ) : null}
        </main>
        <footer className="cs-stage-dock" data-testid="classroom-dock">
          {dock}
        </footer>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
