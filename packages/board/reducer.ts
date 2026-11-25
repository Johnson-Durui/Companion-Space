import type { Block, Board, BoardEvent, BoardMark } from "./types";

function target(value: unknown) {
  if (typeof value !== "string") return { blockId: "", line: undefined };
  const [blockId, rawLine] = value.split(".", 2);
  const line = rawLine && /^\d+$/.test(rawLine) ? Number(rawLine) : undefined;
  return { blockId, line };
}

export function applyVisibleBoardEvent(blocks: readonly Block[], event: BoardEvent): readonly Block[] {
  const { data } = event;
  if (event.type === "point") {
    const { blockId, line } = target(data.target);
    if (!blockId) return blocks;
    return blocks.map((block) => {
      if (block.id === blockId) {
        return {
          ...block,
          point: event.seq ?? String(data.target),
          pointLine: line,
          pointSeq: event.seq,
        };
      }
      if (block.point !== undefined || block.pointLine !== undefined) {
        return { ...block, point: undefined, pointLine: undefined, pointSeq: undefined };
      }
      return block;
    });
  }
  if (event.type === "mark") {
    const { blockId, line } = target(data.target);
    if (!blockId) return blocks;
    const mark: BoardMark = {
      target: String(data.target),
      line,
      style: typeof data.style === "string" ? data.style : undefined,
      color: typeof data.color === "string" ? data.color : undefined,
      seq: event.seq,
    };
    return blocks.map((block) => block.id === blockId
      ? { ...block, mark: true, marks: [...(block.marks ?? []), mark] }
      : block);
  }
  if (event.type === "board_param") {
    const { blockId } = target(data.target);
    const name = typeof data.name === "string" ? data.name : "";
    const numeric = typeof data.value === "number" ? data.value : Number(data.value);
    if (!blockId || !name || !Number.isFinite(numeric)) return blocks;
    return blocks.map((block) => block.id === blockId
      ? {
          ...block,
          paramValues: { ...(block.paramValues ?? {}), [name]: numeric },
          paramSeq: event.seq ?? (block.paramSeq ?? 0) + 1,
        }
      : block);
  }
  if (event.type !== "board") return blocks;
  if (data.op === "clear") return [];
  const content = typeof data.content === "string" ? data.content : "";
  if (data.op === "add" && typeof data.id === "string" && typeof data.type === "string") {
    if (blocks.some((block) => block.id === data.id)) return blocks;
    return [...blocks, {
      id: data.id,
      type: data.type,
      content,
      title: typeof data.title === "string" ? data.title : undefined,
      variant: typeof data.variant === "string" ? data.variant : undefined,
      marks: [],
    }];
  }
  if (data.op !== "append" && data.op !== "update") return blocks;
  return blocks.map((block) => block.id !== data.target ? block : {
    ...block,
    content: data.op === "append" ? `${block.content}\n${content}` : content,
  });
}

export function applyBoardEvent(board: Board, event: BoardEvent): Board {
  const current = board.pages.at(-1) ?? { id: "page-1", blocks: [] };
  if (event.type === "board" && event.data.op === "clear") {
    if (!current.blocks.length && board.pages.length > 0) return board;
    return { pages: [...board.pages, { id: `page-${board.pages.length + 1}`, blocks: [] }] };
  }
  const blocks = applyVisibleBoardEvent(current.blocks, event);
  if (blocks === current.blocks) return board;
  if (!board.pages.length) return { pages: [{ ...current, blocks }] };
  return { pages: [...board.pages.slice(0, -1), { ...current, blocks }] };
}
