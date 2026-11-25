import type { MathNode } from "mathjs/number";

export type PlotParam = {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
};

export type PlotKeyframe = {
  label: string;
  values: Record<string, number>;
};

export type PlotSpec = {
  fn: string[];
  x: [number, number];
  y?: [number, number];
  points: [number, number][];
  holes: [number, number][];
  labels: { at: [number, number]; text: string }[];
  params?: PlotParam[];
  keyframes?: PlotKeyframe[];
};
export type ImageSpec = { material_id: string; page: number; bbox?: [number, number, number, number] };

const functions = new Set(["abs", "acos", "asin", "atan", "ceil", "cos", "exp", "floor", "log", "max", "min", "pow", "round", "sin", "sqrt", "tan"]);
const reservedSymbols = new Set(["x", "e", "pi", ...functions]);
const operators = new Set(["+", "-", "*", "/", "^", "%"]);
const paramNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function pair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);
}

function range(value: unknown): value is [number, number] {
  return pair(value) && value[0] < value[1];
}

export async function validPlotExpression(
  expression: string,
  allowedParams: ReadonlySet<string> = new Set(),
): Promise<boolean> {
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
        if (!reservedSymbols.has(name) && !allowedParams.has(name)) valid = false;
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

function parsePlotParams(raw: unknown): PlotParam[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 4) return null;
  const seen = new Set<string>();
  const params: PlotParam[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["name", "label", "min", "max", "step", "default"].includes(key))) {
      return null;
    }
    const { name, label, min, max, step, default: def } = item;
    if (
      typeof name !== "string"
      || !paramNamePattern.test(name)
      || reservedSymbols.has(name)
      || seen.has(name)
    ) return null;
    if (typeof label !== "string" || !label.trim() || label.length > 32) return null;
    if (!finite(min) || !finite(max) || !finite(step) || !finite(def)) return null;
    if (min >= max || step <= 0 || def < min || def > max) return null;
    seen.add(name);
    params.push({ name, label: label.trim(), min, max, step, default: def });
  }
  return params;
}

function parsePlotKeyframes(raw: unknown, params: readonly PlotParam[]): PlotKeyframe[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 8) return null;
  if (raw.length > 0 && params.length === 0) return null;
  const byName = new Map(params.map((param) => [param.name, param]));
  const keyframes: PlotKeyframe[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "label" && key !== "values")) return null;
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 40) return null;
    if (!item.values || typeof item.values !== "object" || Array.isArray(item.values)) return null;
    const values: Record<string, number> = {};
    const entries = Object.entries(item.values as Record<string, unknown>);
    if (entries.length === 0) return null;
    for (const [key, val] of entries) {
      const def = byName.get(key);
      if (!def || !finite(val) || val < def.min || val > def.max) return null;
      values[key] = val;
    }
    keyframes.push({ label: item.label.trim(), values });
  }
  return keyframes;
}

export async function parsePlotSpec(source: string): Promise<PlotSpec | null> {
  try {
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["fn", "x", "y", "points", "holes", "labels", "params", "keyframes"].includes(key))) {
      return null;
    }
    const params = parsePlotParams(value.params);
    if (params === null) return null;
    const keyframes = parsePlotKeyframes(value.keyframes, params);
    if (keyframes === null) return null;
    const allowedParams = new Set(params.map((param) => param.name));
    if (!Array.isArray(value.fn) || !value.fn.length || value.fn.length > 6
      || value.fn.some((fn) => typeof fn !== "string") || !range(value.x)) return null;
    if (!(await Promise.all((value.fn as string[]).map((expr) => validPlotExpression(expr, allowedParams)))).every(Boolean)) {
      return null;
    }
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
      ...(params.length ? { params } : {}),
      ...(keyframes.length ? { keyframes } : {}),
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

