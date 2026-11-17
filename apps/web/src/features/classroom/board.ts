import type { LessonEvent } from "./timeline";

export type Block = { id: string; type: string; content: string; title?: string; mark?: boolean };

export function applyBoardEvent(blocks: readonly Block[], event: LessonEvent): readonly Block[] {
  const { data } = event;
  if (event.type === "mark") {
    const id = typeof data.target === "string" ? data.target.split(".")[0] : "";
    return blocks.map((block) => block.id === id ? { ...block, mark: true } : block);
  }
  if (event.type !== "board") return blocks;
  if (data.op === "clear") return [];
  const content = typeof data.content === "string" ? data.content : "";
  if (data.op === "add" && typeof data.id === "string" && typeof data.type === "string") {
    if (blocks.some((block) => block.id === data.id)) return blocks;
    return [...blocks, { id: data.id, type: data.type, content, title: typeof data.title === "string" ? data.title : undefined }];
  }
  if (data.op !== "append" && data.op !== "update") return blocks;
  return blocks.map((block) => block.id !== data.target ? block : {
    ...block, content: data.op === "append" ? block.content + "\n" + content : content,
  });
}
