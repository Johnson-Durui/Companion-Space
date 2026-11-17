import type { RealtimeEventWire, SessionDetail, SessionRecordWire, SessionSummary, SessionTranscriptResponseWire, TtsPlaybackPolicy } from "@/lib/types";
import { contractError, expectNullableString, expectRecord, expectString } from "./transport";
import { expectOptionalNullableString } from "./character-codec";
import { toMemoryView } from "./memory";
import { toReviewView } from "./review";

export function asRealtimeEvent(payload: unknown, context: string): RealtimeEventWire {
  const record = expectRecord(payload, context);
  return {
    type: expectString(record.type, `${context}.type`),
    session_id: expectString(record.session_id, `${context}.session_id`),
    state:
      record.state === null
        ? null
        : expectString(record.state, `${context}.state`) as RealtimeEventWire["state"],
    payload: expectRecord(record.payload, `${context}.payload`),
  };
}

export function eventErrorMessage(event: RealtimeEventWire): string | null {
  if (typeof event.payload.message === "string") {
    return event.payload.message;
  }
  if (typeof event.payload.text === "string") {
    return event.payload.text;
  }
  return null;
}

function expectTtsPlaybackPolicy(
  value: unknown,
  context: string,
): TtsPlaybackPolicy | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (value === "browser-compat" || value === "server-neural" || value === "server") {
    return value;
  }
  throw contractError(`${context} 字段无效`, value);
}

export function decodeSessionRecordWire(payload: unknown, context: string): SessionRecordWire {
  const record = expectRecord(payload, context);
  return {
    ...(record as unknown as SessionRecordWire),
    character_pack_id: expectNullableString(
      record.character_pack_id,
      `${context}.character_pack_id`,
    ),
    tts_connection_id: expectOptionalNullableString(
      record.tts_connection_id,
      `${context}.tts_connection_id`,
    ),
    tts_model_name: expectOptionalNullableString(
      record.tts_model_name,
      `${context}.tts_model_name`,
    ),
    tts_playback_policy: expectTtsPlaybackPolicy(
      record.tts_playback_policy,
      `${context}.tts_playback_policy`,
    ),
  };
}

export function toSessionSummary(
  session: SessionRecordWire,
  options: { spaceTitle?: string; turnCount?: number } = {},
): SessionSummary {
  const sessionTitle = options.spaceTitle
    ? `${options.spaceTitle} · 会话复盘`
    : "会话复盘";
  return {
    id: session.id,
    title: sessionTitle,
    space_id: session.space_id,
    character_pack_id: expectNullableString(
      session.character_pack_id,
      "session.character_pack_id",
    ),
    space_title: options.spaceTitle,
    state: session.state,
    turn_count: options.turnCount,
    tts_connection_id: session.tts_connection_id,
    tts_model_name: session.tts_model_name,
    tts_playback_policy: session.tts_playback_policy,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

export function toSessionDetail(
  payload: SessionTranscriptResponseWire,
  options: { spaceTitle?: string } = {},
): SessionDetail {
  return {
    ...toSessionSummary(payload.session, {
      turnCount: payload.turns.length,
      spaceTitle: options.spaceTitle,
    }),
    transcript: payload.turns,
    summary: payload.session.summary,
    generated_summary: payload.session.generated_summary ?? payload.session.summary,
    notes: payload.session.notes ?? "",
    artifacts_status: payload.session.artifacts_status ?? "idle",
    artifacts_error: payload.session.artifacts_error ?? null,
    artifacts_updated_at: payload.session.artifacts_updated_at ?? null,
    memory_candidates: (payload.memory_candidates ?? []).map(toMemoryView),
    review_items: (payload.review_items ?? []).map(toReviewView),
  };
}
