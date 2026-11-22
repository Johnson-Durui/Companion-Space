import { Link } from "react-router";
import { LessonText } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import { ArrowLeft, Card } from "../../ui";
import type { Block } from "./board";
import { BoardBlock } from "./board-block";

const copy = t.classroom;

export interface RecapViewProps {
  lessonId: string;
  courseId: string;
  title: string;
  summary?: string;
  board: Block[];
}

export function RecapView({ lessonId, courseId, title, summary, board }: RecapViewProps) {
  return (
    <div
      data-surface="desk"
      data-phase="ended"
      className="min-h-dvh bg-surface-page text-fg-primary"
    >
      <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[880px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            to={`/courses/${courseId}`}
            className="inline-flex min-h-10 items-center gap-1.5 text-ui font-medium text-fg-secondary hover:text-fg-primary"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{copy.back}</span>
          </Link>
          <span className="truncate text-caption text-fg-tertiary">{title}</span>
        </div>
      </header>

      <main id="main" className="mx-auto grid max-w-[880px] gap-6 px-4 py-8 sm:px-6">
        <div className="grid gap-1.5">
          <h1 className="text-display font-semibold text-fg-primary">{title}</h1>
          <h2 className="text-title font-semibold text-accent-strong">{copy.recap}</h2>
        </div>

        <Card padding="lg" className="grid gap-4">
          {typeof summary === "string" && summary.trim() ? (
            <div className="prose-like text-body leading-relaxed text-fg-primary">
              <LessonText source={summary} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link className="button quiet" to={`/lessons/${lessonId}/history`}>
              {t.history.replay}
            </Link>
            <Link className="button primary" to={`/courses/${courseId}`}>
              {copy.back}
            </Link>
          </div>
        </Card>

        {board.length > 0 ? (
          <Card padding="md">
            <details className="grid gap-3">
              <summary className="cursor-pointer text-ui font-semibold text-fg-primary select-none">
                {copy.board}
              </summary>
              <div className="grid gap-4 pt-3">
                {board.map((block) => (
                  <BoardBlock key={block.id} block={block} />
                ))}
              </div>
            </details>
          </Card>
        ) : null}
      </main>
    </div>
  );
}
