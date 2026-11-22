import { useEffect, type ReactNode } from "react";
import type { LessonPhase } from "@companion-space/avatar-engine/types";
import { Toaster, TooltipProvider } from "../ui";
import "./stage-shell.css";

export interface StageShellProps {
  phase: LessonPhase;
  topbar: ReactNode;
  stage: ReactNode;
  board: ReactNode;
  dock: ReactNode;
  textMode?: boolean;
}

export function StageShell({
  phase,
  topbar,
  stage,
  board,
  dock,
  textMode = false,
}: StageShellProps) {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = meta?.content;
    if (meta) meta.content = "#0E1116";
    return () => {
      if (meta && previous) meta.content = previous;
    };
  }, []);

  return (
    <TooltipProvider>
      <div
        className="cs-stage-shell"
        data-surface="stage"
        data-phase={phase}
        data-testid="classroom-stage-shell"
      >
        <header className="cs-stage-topbar">{topbar}</header>
        <main id="main" className="cs-stage-main">
          <aside
            className="cs-stage-left"
            data-testid="lesson-stage"
            data-text-mode={textMode ? "true" : undefined}
          >
            {stage}
          </aside>
          <section className="cs-stage-right" aria-label="白板与作答区">
            {board}
          </section>
        </main>
        <footer className="cs-stage-dock" data-testid="classroom-dock">
          {dock}
        </footer>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
