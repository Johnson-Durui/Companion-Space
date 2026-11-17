import type {
  BoardAction,
  BoardUpdatePayload,
  Citation,
  DemoReadyPayload,
  LessonScript,
  LessonStep,
  SessionDemoResponseWire,
} from "@/lib/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(
  value: unknown,
  { maxLength }: { maxLength: number },
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function decodeCitation(value: unknown): Citation | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.chunk_id !== "string" ||
    typeof value.material_id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.locator !== "string" ||
    (value.excerpt !== null && value.excerpt !== undefined && typeof value.excerpt !== "string")
  ) {
    return null;
  }
  return {
    chunk_id: value.chunk_id,
    material_id: value.material_id,
    title: value.title,
    locator: value.locator,
    excerpt: value.excerpt ?? null,
  };
}

function decodeCitations(value: unknown): Citation[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const citations = value.map(decodeCitation);
  return citations.some((citation) => citation === null) ? null : (citations as Citation[]);
}

export function decodeBoardAction(value: unknown): BoardAction | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (
    (kind !== "mermaid" && kind !== "markdown" && kind !== "highlight") ||
    !isBoundedText(value.content, { maxLength: 4000 })
  ) {
    return null;
  }
  if (
    value.target !== undefined &&
    value.target !== null &&
    !isBoundedText(value.target, { maxLength: 240 })
  ) {
    return null;
  }
  if (kind === "highlight" && !isBoundedText(value.target, { maxLength: 240 })) {
    return null;
  }
  return {
    kind,
    content: value.content,
    target: typeof value.target === "string" ? value.target : null,
  };
}

export function decodeBoardActions(value: unknown): BoardAction[] | null {
  if (!Array.isArray(value) || value.length > 1) {
    return null;
  }
  const boardActions = value.map(decodeBoardAction);
  return boardActions.some((boardAction) => boardAction === null)
    ? null
    : (boardActions as BoardAction[]);
}

export function decodeLessonStep(value: unknown): LessonStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const board = decodeBoardAction(value.board);
  if (
    !board ||
    !isBoundedText(value.caption, { maxLength: 400 }) ||
    !isBoundedText(value.narration, { maxLength: 1200 })
  ) {
    return null;
  }
  return {
    board,
    caption: value.caption,
    narration: value.narration,
  };
}

export function decodeLessonScript(value: unknown): LessonScript | null {
  if (
    !isRecord(value) ||
    !isBoundedText(value.title, { maxLength: 120 }) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 3 ||
    value.steps.length > 8
  ) {
    return null;
  }
  const steps = value.steps.map(decodeLessonStep);
  if (steps.some((step) => step === null)) {
    return null;
  }
  return {
    title: value.title,
    steps: steps as LessonStep[],
  };
}

export function decodeBoardUpdatePayload(value: unknown): BoardUpdatePayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const boardActions = decodeBoardActions(value.board_actions);
  if (!boardActions) {
    return null;
  }
  if (
    value.turn_id !== undefined &&
    value.turn_id !== null &&
    typeof value.turn_id !== "string"
  ) {
    return null;
  }
  return {
    board_actions: boardActions,
    turn_id: typeof value.turn_id === "string" ? value.turn_id : null,
  };
}

export function decodeDemoReadyPayload(value: unknown): DemoReadyPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const script = decodeLessonScript(value.script);
  const citations = decodeCitations(value.citations);
  if (
    typeof value.session_id !== "string" ||
    typeof value.topic !== "string" ||
    !script ||
    !citations ||
    typeof value.used_space_materials !== "boolean"
  ) {
    return null;
  }
  return {
    session_id: value.session_id,
    topic: value.topic,
    script,
    citations,
    used_space_materials: value.used_space_materials,
  };
}

export function decodeSessionDemoResponse(value: unknown): SessionDemoResponseWire | null {
  if (!isRecord(value)) {
    return null;
  }
  const script = decodeLessonScript(value.script);
  const citations = decodeCitations(value.citations);
  if (
    typeof value.session_id !== "string" ||
    typeof value.topic !== "string" ||
    !script ||
    !citations ||
    typeof value.used_space_materials !== "boolean"
  ) {
    return null;
  }
  return {
    session_id: value.session_id,
    topic: value.topic,
    script,
    citations,
    used_space_materials: value.used_space_materials,
  };
}
