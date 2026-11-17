import {
  decodeBoardActions,
  decodeBoardUpdatePayload,
  decodeDemoReadyPayload,
} from "@/components/lesson/lesson-contract";
import { isCompanionEmotion } from "@/lib/types";
import type {
  BoardUpdatePayload,
  Citation,
  CompanionEmotion,
  CompanionTurn,
  DemoReadyPayload,
  SessionState as ApiSessionState,
  UsageRecord,
} from "@/lib/types";

export type SessionState = ApiSessionState;

export type CitationPreview = Pick<Citation, "title" | "locator">;

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: "final" | "interrupted";
  citations?: CitationPreview[];
  emotion?: CompanionEmotion;
}

export interface RealtimeEvent {
  type: string;
  session_id: string;
  state: SessionState | null;
  payload: Record<string, unknown>;
}

export { decodeBoardUpdatePayload, decodeDemoReadyPayload };
export type { BoardUpdatePayload, DemoReadyPayload };

const SESSION_STATES: ReadonlySet<string> = new Set([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "interrupted",
  "error",
  "closed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
    (value.excerpt !== null && typeof value.excerpt !== "string")
  ) {
    return null;
  }
  return {
    chunk_id: value.chunk_id,
    material_id: value.material_id,
    title: value.title,
    locator: value.locator,
    excerpt: value.excerpt,
  };
}

function decodeUsage(value: unknown): UsageRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.input_tokens !== "number" ||
    typeof value.output_tokens !== "number" ||
    typeof value.audio_input_bytes !== "number" ||
    typeof value.audio_output_bytes !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    audio_input_bytes: value.audio_input_bytes,
    audio_output_bytes: value.audio_output_bytes,
  };
}

export function decodeRealtimeEvent(raw: string): RealtimeEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== "string" || typeof value.session_id !== "string") {
      return null;
    }
    if (
      value.state !== null &&
      value.state !== undefined &&
      (typeof value.state !== "string" || !SESSION_STATES.has(value.state))
    ) {
      return null;
    }
    if (!isRecord(value.payload)) {
      return null;
    }
    return {
      type: value.type,
      session_id: value.session_id,
      state: (value.state ?? null) as SessionState | null,
      payload: value.payload,
    };
  } catch {
    return null;
  }
}

export function decodeCompanionTurn(value: unknown): CompanionTurn | null {
  if (!isRecord(value)) {
    return null;
  }
  const payload = value;
  if (
    typeof payload.id !== "string" ||
    typeof payload.session_id !== "string" ||
    typeof payload.space_id !== "string" ||
    (payload.role !== "user" && payload.role !== "assistant") ||
    typeof payload.display_text !== "string" ||
    typeof payload.spoken_text !== "string" ||
    !isCompanionEmotion(payload.emotion) ||
    !isStringArray(payload.suggested_actions) ||
    typeof payload.created_at !== "string" ||
    !Array.isArray(payload.citations)
  ) {
    return null;
  }

  const citations = payload.citations.map(decodeCitation);
  const usage = decodeUsage(payload.usage);
  const boardActions =
    payload.board_actions === undefined
      ? undefined
      : decodeBoardActions(payload.board_actions);
  if (
    citations.some((citation) => citation === null) ||
    !usage ||
    (payload.board_actions !== undefined && !boardActions)
  ) {
    return null;
  }

  return {
    id: payload.id,
    session_id: payload.session_id,
    space_id: payload.space_id,
    role: payload.role,
    display_text: payload.display_text,
    spoken_text: payload.spoken_text,
    emotion: payload.emotion,
    citations: citations as Citation[],
    board_actions: boardActions ?? undefined,
    suggested_actions: payload.suggested_actions,
    usage,
    created_at: payload.created_at,
  };
}

export function toTranscriptTurn(turn: CompanionTurn): TranscriptTurn {
  return {
    id: turn.id,
    role: turn.role,
    text: turn.display_text,
    status: "final",
    citations: turn.citations.map(({ title, locator }) => ({ title, locator })),
    emotion: turn.emotion,
  };
}
