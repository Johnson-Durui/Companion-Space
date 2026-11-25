export const blockTypes = [
  "title", "text", "math", "list", "table", "code", "diagram", "plot", "image", "callout", "steps", "question",
] as const;

export type BlockType = typeof blockTypes[number];
export type BoardMark = {
  target: string;
  line?: number;
  style?: "underline" | "box" | "color" | string;
  color?: "accent" | "ok" | "warn" | string;
  seq?: number;
};
export type Block = {
  id: string;
  type: BlockType | string;
  content: string;
  title?: string;
  variant?: string;
  marks?: readonly BoardMark[];
  /** Compatibility for pre-M4 callers. */
  mark?: boolean;
  point?: number | string;
  pointLine?: number;
  pointSeq?: number;
  paramValues?: Record<string, number>;
  paramSeq?: number;
};
export type Page = { id: string; blocks: readonly Block[] };
export type Board = { pages: readonly Page[] };

export type BoardEvent = {
  type: string;
  data: Record<string, unknown>;
  seq?: number;
};
