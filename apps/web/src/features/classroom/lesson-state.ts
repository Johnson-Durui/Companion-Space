import type { InstantAction, TutorEmotion, TutorPose } from "@companion-space/avatar-engine/types";
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

export type AvatarState = {
  emotion: TutorEmotion;
  pose: TutorPose;
  gaze: { active: boolean; x: number; y: number };
  gestureSequence: number;
  reactionKey: string | null;
  instantAction: InstantAction | null;
  gen: number;
  seg: number;
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
  board: [],
  caption: "",
  stage: "opening",
  paused: false,
  avatar: {
    emotion: "warm",
    pose: "greeting",
    gaze: { active: false, x: 0, y: 0 },
    gestureSequence: 0,
    reactionKey: null,
    instantAction: null,
    gen: 0,
    seg: 0,
  },
};

function parseEmotion(value: unknown, fallback: TutorEmotion): TutorEmotion {
  return typeof value === "string" && avatarEmotions.has(value) ? (value as TutorEmotion) : fallback;
}

export function advanceClassroom(state: ClassroomState, event: LessonEvent): ClassroomState {
  const { data } = event;
  const gen = Math.max(state.avatar.gen, event.gen);
  switch (event.type) {
    case "board":
    case "mark":
      return {
        ...state,
        board: applyBoardEvent(state.board, event),
        avatar: {
          ...state.avatar,
          gen,
          pose: "board_guiding",
          gaze: { active: true, x: 0.72, y: 0.05 },
        },
      };
    case "say": {
      const seg = typeof data.seg === "number" ? data.seg : state.avatar.seg + 1;
      const pose: TutorPose = state.stage === "opening" && seg <= 1 ? "greeting" : "lecturing";
      return {
        ...state,
        caption: String(data.text ?? ""),
        avatar: {
          ...state.avatar,
          gen,
          seg,
          pose,
          emotion: parseEmotion(data.emotion, state.avatar.emotion),
          gaze: { active: false, x: 0, y: 0 },
          instantAction: null,
        },
      };
    }
    case "point":
      return {
        ...state,
        board: applyBoardEvent(state.board, event),
        avatar: {
          ...state.avatar,
          gen,
          pose: "board_guiding",
          emotion: "focused",
          gaze: { active: true, x: 0.72, y: 0.05 },
          gestureSequence: event.seq,
          instantAction: "board_point",
        },
      };
    case "cue": {
      const look = String(data.look ?? "");
      const pointingBoard = look === "board";
      return {
        ...state,
        avatar: {
          ...state.avatar,
          gen,
          pose: pointingBoard ? "board_guiding" : state.avatar.pose,
          emotion: parseEmotion(data.emotion, state.avatar.emotion),
          gaze: pointingBoard
            ? { active: true, x: 0.72, y: 0.05 }
            : look === "student"
              ? { active: false, x: 0, y: 0 }
              : state.avatar.gaze,
          gestureSequence: data.gesture ? event.seq : state.avatar.gestureSequence,
        },
      };
    }
    case "beat.start":
      return {
        ...state,
        ask: undefined,
        caption: "",
        avatar: { ...state.avatar, gen, seg: 0, instantAction: null },
      };
    case "ask": {
      const sameAsk = state.ask?.item_id === data.item_id && state.ask?.purpose === data.purpose;
      return {
        ...state,
        ask: data as Ask,
        askSeq: sameAsk ? state.askSeq : event.seq,
        judge: sameAsk ? state.judge : undefined,
        avatar: { ...state.avatar, gen, pose: "listening_empathy" },
      };
    }
    case "judge": {
      const verdict = typeof data.verdict === "string" ? data.verdict : undefined;
      if (!verdict) return state;
      const correct = verdict === "correct";
      return {
        ...state,
        judge: verdict,
        avatar: {
          ...state.avatar,
          gen,
          pose: "feedback_reaction",
          emotion: correct ? "cheerful" : "concerned",
          gestureSequence: event.seq,
          reactionKey: `teaching:${correct ? "correct" : "retry"}:${event.seq}`,
          instantAction: correct ? "praise_thumbs_up" : "gentle_encourage",
        },
      };
    }
    case "state":
      return {
        ...state,
        stage: String(data.stage ?? state.stage),
        paused: data.paused === true,
        avatar: data.paused === true ? { ...state.avatar, gen, pose: "idle_companion" } : { ...state.avatar, gen },
      };
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
    if (
      event.type !== "state" &&
      event.type !== "beat.cancelled" &&
      interruptions.get(event.gen)?.some(({ heard, cancelled }) => event.seq > heard && event.seq < cancelled)
    ) {
      return state;
    }
    return advanceClassroom(state, event);
  }, initialClassroom);
}

export type ClassroomStatusKey =
  | "connecting"
  | "waitingStart"
  | "paused"
  | "listening"
  | "speaking"
  | "quietCompanion"
  | "waiting"
  | "thinking";

export function resolveClassroomDisplay(input: {
  connected: boolean;
  started: boolean;
  roomSeq: number;
  recording: boolean;
  speaking: boolean;
  quietCompanion: boolean;
  submitted: boolean;
  instantAction: InstantAction | null;
  classroom: ClassroomState;
}): { awaitingAnswer: boolean; statusKey: ClassroomStatusKey; pose: TutorPose } {
  const { connected, started, roomSeq, recording, speaking, quietCompanion, submitted, instantAction, classroom } = input;
  const awaitingAnswer = Boolean(classroom.ask) && !submitted && !classroom.judge;
  const hasStartedBefore = classroom.paused || roomSeq > 0;
  const statusKey: ClassroomStatusKey = !connected
    ? "connecting"
    : !started
      ? (hasStartedBefore ? "paused" : "waitingStart")
      : recording
        ? "listening"
        : speaking
          ? "speaking"
          : awaitingAnswer
            ? (quietCompanion ? "quietCompanion" : "waiting")
            : "thinking";

  const pose: TutorPose = !started
    ? "idle_companion"
    : recording
      ? "listening_empathy"
      : instantAction
        ? (instantAction === "board_point" ? "board_guiding" : "feedback_reaction")
        : speaking
          ? (classroom.avatar.pose === "board_guiding"
            ? "board_guiding"
            : classroom.stage === "opening" && classroom.avatar.seg <= 1
              ? "greeting"
              : "lecturing")
          : awaitingAnswer
            ? (quietCompanion ? "idle_companion" : "listening_empathy")
            : (classroom.avatar.pose === "lecturing" || classroom.avatar.pose === "greeting"
              ? "idle_companion"
              : classroom.avatar.pose);

  return { awaitingAnswer, statusKey, pose };
}
