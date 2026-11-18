import { applyBoardEvent, type Block } from "./board";
import type { LessonEvent } from "./timeline";

export type Ask = {
  kind: string;
  purpose: string;
  item_id?: string;
  widget?: { type: string; stem: string; options: { key: string; text: string }[] };
};
export type Prefill = { item_id: string; value: string | string[]; via: "voice" | "text" };

const avatarEmotions = new Set(["neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned"]);
type AvatarEmotion = "neutral" | "warm" | "cheerful" | "curious" | "focused" | "playful" | "concerned";
type AvatarState = {
  emotion: AvatarEmotion;
  gaze: { active: boolean; x: number; y: number };
  gestureSequence: number;
  reactionKey: string | null;
};

export type ClassroomState = {
  board: readonly Block[];
  caption: string;
  ask?: Ask;
  askSeq?: number;
  judge?: string;
  stage: string;
  paused: boolean;
  avatar: AvatarState;
};

export const initialClassroom: ClassroomState = {
  board: [], caption: "", stage: "opening", paused: false,
  avatar: { emotion: "neutral", gaze: { active: false, x: 0, y: 0 }, gestureSequence: 0, reactionKey: null },
};

function emotion(value: unknown, fallback: AvatarEmotion): AvatarEmotion {
  return typeof value === "string" && avatarEmotions.has(value) ? value as AvatarEmotion : fallback;
}

export function advanceClassroom(state: ClassroomState, event: LessonEvent): ClassroomState {
  const { data } = event;
  switch (event.type) {
    case "board":
    case "mark":
      return { ...state, board: applyBoardEvent(state.board, event) };
    case "say":
      return { ...state, caption: String(data.text ?? ""), avatar: {
        ...state.avatar, emotion: emotion(data.emotion, state.avatar.emotion), gaze: { active: false, x: 0, y: 0 },
      } };
    case "point":
      return { ...state, board: applyBoardEvent(state.board, event), avatar: {
        ...state.avatar, gaze: { active: true, x: 0.72, y: 0.05 }, gestureSequence: event.seq,
      } };
    case "cue": {
      const look = String(data.look ?? "");
      return { ...state, avatar: {
        ...state.avatar,
        emotion: emotion(data.emotion, state.avatar.emotion),
        gaze: look === "board" ? { active: true, x: 0.72, y: 0.05 } : look === "student" ? { active: false, x: 0, y: 0 } : state.avatar.gaze,
        gestureSequence: data.gesture ? event.seq : state.avatar.gestureSequence,
      } };
    }
    case "beat.start":
      return { ...state, ask: undefined, caption: "" };
    case "ask":
      return { ...state, ask: data as Ask, askSeq: state.ask?.item_id === data.item_id && state.ask?.purpose === data.purpose
        ? state.askSeq : event.seq };
    case "judge": {
      const verdict = typeof data.verdict === "string" ? data.verdict : undefined;
      const correct = verdict === "correct";
      return { ...state, judge: verdict, avatar: {
        ...state.avatar,
        emotion: correct ? "cheerful" : "concerned",
        gestureSequence: event.seq,
        reactionKey: `teaching:${correct ? "correct" : "retry"}:${event.seq}`,
      } };
    }
    case "state":
      return { ...state, stage: String(data.stage ?? state.stage), paused: data.paused === true };
    default:
      return state;
  }
}

export function restoreClassroom(events: readonly LessonEvent[], through: number) {
  const interruptions = new Map<number, Array<{ heard: number; cancelled: number }>>();
  for (const event of events) {
    if (event.type === "beat.cancelled" && typeof event.data.heard_seq === "number") {
      const entries = interruptions.get(event.gen) ?? [];
      entries.push({ heard: event.data.heard_seq, cancelled: event.seq });
      interruptions.set(event.gen, entries);
    }
  }
  return events.reduce((state, event) => {
    if (event.seq > through) return state;
    if (event.type !== "state" && event.type !== "beat.cancelled" && interruptions.get(event.gen)?.some(
      ({ heard, cancelled }) => event.seq > heard && event.seq < cancelled,
    )) return state;
    return advanceClassroom(state, event);
  }, initialClassroom);
}
