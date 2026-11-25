export {
  BoardBlock,
  nextRevealCount,
  normalizeMarkStyle,
  type BoardBlockProps,
  type BoardLabels,
  type NormalizedMarkStyle,
} from "./components";
export { DiagramBlock } from "./diagram";
export { boardMarkdown } from "./markdown";
export { LessonText, MathBlock } from "./math";
export { PlotBlock } from "./plot";
export { applyBoardEvent, applyVisibleBoardEvent } from "./reducer";
export { blockTypes, type Block, type BlockType, type Board, type BoardEvent, type BoardMark, type Page } from "./types";
export {
  parseImageSpec,
  parsePlotSpec,
  validPlotExpression,
  type ImageSpec,
  type PlotKeyframe,
  type PlotParam,
  type PlotSpec,
} from "./validation";
