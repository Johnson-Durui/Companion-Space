import type { MathNode } from "mathjs/number";

export type PlotSpec = {
  fn: string[];
  x: [number, number];
  y?: [number, number];
  points: [number, number][];
  holes: [number, number][];
  labels: { at: [number, number]; text: string }[];
};
export type ImageSpec = { material_id: string; page: number; bbox?: [number, number, number, number] };

const functions = new Set(["abs", "acos", "asin", "atan", "ceil", "cos", "exp", "floor", "log", "max", "min", "pow", "round", "sin", "sqrt", "tan"]);
const operators = new Set(["+", "-", "*", "/", "^", "%"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function pair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
}

function range(value: unknown): value is [number, number] {
  return pair(value) && value[0] < value[1];
}

export async function validPlotExpression(expression: string): Promise<boolean> {
  if (!expression || expression.length > 240) return false;
  try {
    const { parse } = await import("mathjs/number");
    const tree = parse(expression);
    let valid = true;
    tree.traverse((node: MathNode) => {
      if (!valid) return;
      if (node.type === "ConstantNode" || node.type === "ParenthesisNode") return;
      if (node.type === "SymbolNode") {
        const name = (node as MathNode & { name: string }).name;
        if (!new Set(["x", "e", "pi", ...functions]).has(name)) valid = false;
        return;
      }
      if (node.type === "OperatorNode") {
        if (!operators.has((node as MathNode & { op: string }).op)) valid = false;
        return;
      }
      if (node.type === "FunctionNode") {
        const fn = (node as MathNode & { fn: MathNode & { name?: string } }).fn;
        if (fn.type !== "SymbolNode" || !fn.name || !functions.has(fn.name)) valid = false;
        return;
      }
      valid = false;
    });
    return valid;
  } catch { return false; }
}

export async function parsePlotSpec(source: string): Promise<PlotSpec | null> {
  try {
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["fn", "x", "y", "points", "holes", "labels"].includes(key))) return null;
    if (!Array.isArray(value.fn) || !value.fn.length || value.fn.length > 6
      || value.fn.some((fn) => typeof fn !== "string") || !range(value.x)) return null;
    if (!(await Promise.all((value.fn as string[]).map(validPlotExpression))).every(Boolean)) return null;
    if (value.y !== undefined && !range(value.y)) return null;
    const points = value.points ?? [];
    const holes = value.holes ?? [];
    if (!Array.isArray(points) || points.length > 32 || !points.every(pair)
      || !Array.isArray(holes) || holes.length > 32 || !holes.every(pair)) return null;
    const labels = value.labels ?? [];
    if (!Array.isArray(labels) || labels.length > 24 || !labels.every((label) => {
      if (!label || typeof label !== "object" || Array.isArray(label)) return false;
      const item = label as Record<string, unknown>;
      return Object.keys(item).every((key) => key === "at" || key === "text")
        && pair(item.at) && typeof item.text === "string" && item.text.length <= 80;
    })) return null;
    return {
      fn: value.fn as string[], x: value.x, y: value.y as [number, number] | undefined,
      points: points as [number, number][], holes: holes as [number, number][],
      labels: labels as { at: [number, number]; text: string }[],
    };
  } catch { return null; }
}

export function parseImageSpec(source: string): ImageSpec | null {
  try {
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["material_id", "page", "bbox"].includes(key))
      || typeof value.material_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.material_id)
      || !Number.isInteger(value.page) || (value.page as number) < 1 || (value.page as number) > 100_000) return null;
    if (value.bbox !== undefined && (!Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every(finite)
      || value.bbox[0] >= value.bbox[2] || value.bbox[1] >= value.bbox[3])) return null;
    return { material_id: value.material_id, page: value.page as number, bbox: value.bbox as ImageSpec["bbox"] };
  } catch { return null; }
}

