import { BoardBlock as SharedBoardBlock } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import type { Block } from "./board";

export interface ClassroomBoardBlockProps {
  block: Block;
  locate?: (target: string) => void;
  latestMarkSeq?: number;
  isActiveBlock?: boolean;
  progressiveSteps?: boolean;
  reducedMotion?: boolean;
  showTools?: boolean;
  onZoom?: (block: Block) => void;
}

export function BoardBlock({
  block,
  locate,
  latestMarkSeq,
  isActiveBlock,
  progressiveSteps,
  reducedMotion,
  showTools,
  onZoom,
}: ClassroomBoardBlockProps) {
  return (
    <SharedBoardBlock
      block={block}
      locate={locate}
      latestMarkSeq={latestMarkSeq}
      isActiveBlock={isActiveBlock}
      progressiveSteps={progressiveSteps}
      reducedMotion={reducedMotion}
      showTools={showTools}
      onZoom={onZoom}
      labels={{
        locate: t.classroom.locate,
        renderError: t.classroom.boardRenderError,
        viewSource: t.classroom.boardViewSource,
        imageAlt: t.classroom.boardImageAlt,
        copy: t.classroom.boardCopy,
        copied: t.classroom.boardCopied,
        zoom: t.classroom.boardZoom,
      }}
    />
  );
}
