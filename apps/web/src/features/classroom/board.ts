import {
  applyBoardEvent as applyPaginatedBoardEvent,
  applyVisibleBoardEvent,
  type Block,
  type Board,
  type Page,
} from "@companion-space/board";
import type { LessonEvent } from "./timeline";

export type { Block, Board, Page } from "@companion-space/board";
export { boardMarkdown } from "@companion-space/board";

export function applyBoardEvent(blocks: readonly Block[], event: LessonEvent): readonly Block[] {
  return applyVisibleBoardEvent(blocks, event);
}

export function applyBoardPagesEvent(pages: readonly Page[], event: LessonEvent): readonly Page[] {
  const next: Board = applyPaginatedBoardEvent({ pages }, event);
  return next.pages;
}
