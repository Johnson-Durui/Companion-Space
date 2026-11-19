import { applyVisibleBoardEvent, type Block } from "@companion-space/board";
import type { LessonEvent } from "./timeline";

export type { Block } from "@companion-space/board";
export { boardMarkdown } from "@companion-space/board";

export function applyBoardEvent(blocks: readonly Block[], event: LessonEvent): readonly Block[] {
  return applyVisibleBoardEvent(blocks, event);
}
