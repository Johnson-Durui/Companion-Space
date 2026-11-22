import { BoardBlock as SharedBoardBlock } from "@companion-space/board";
import t from "../../locales/zh-CN.json";
import type { Block } from "./board";

export function BoardBlock({ block, locate }: { block: Block; locate?: (target: string) => void }) {
  return (
    <SharedBoardBlock
      block={block}
      locate={locate}
      labels={{
        locate: t.classroom.locate,
        renderError: t.classroom.boardRenderError,
        viewSource: t.classroom.boardViewSource,
        imageAlt: t.classroom.boardImageAlt,
      }}
    />
  );
}
