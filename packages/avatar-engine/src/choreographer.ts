import type { ClipSlot, InstantAction, TutorEmotion, TutorPose } from "./types";

export const IDLE_COMPANION_MS = 15_000;
export const BOARD_GUIDE_HOLD_MS = 2_600;
export const REACTION_HOLD_MS = 2_800;

export const ONE_SHOT_CLIPS: ReadonlySet<ClipSlot> = new Set([
  "board_point",
  "react_praise",
  "react_comfort",
]);

export interface ChoreographerState {
  pose: TutorPose;
  emotion: TutorEmotion;
  clip: ClipSlot;
  gen: number;
  lectureVariant: 0 | 1;
  activeAction: InstantAction | null;
  quietCompanion: boolean;
  waitingSinceMs: number | null;
}

export function createInitialChoreographerState(): ChoreographerState {
  return {
    pose: "greeting",
    emotion: "warm",
    clip: "idle_breathe",
    gen: 0,
    lectureVariant: 0,
    activeAction: null,
    quietCompanion: false,
    waitingSinceMs: null,
  };
}

export function quickActionToInstantAction(kind: string): InstantAction | null {
  if (kind === "confused" || kind === "slower" || kind === "repeat") return "gentle_encourage";
  if (kind === "hint" || kind === "example") return "think_chin";
  if (kind === "show_answer" || kind.startsWith("locate:")) return "board_point";
  if (kind === "break") return "empathy_nod";
  return null;
}

export function verdictToInstantAction(verdict: string | undefined): InstantAction | null {
  if (!verdict) return null;
  if (verdict === "correct") return "praise_thumbs_up";
  return "gentle_encourage";
}

export function actionToClipSlot(action: InstantAction): ClipSlot {
  switch (action) {
    case "greet":
      return "speak_explain_a";
    case "empathy_nod":
      return "listen_nod";
    case "think_chin":
      return "think_chin";
    case "praise_thumbs_up":
    case "praise_clap":
      return "react_praise";
    case "gentle_encourage":
      return "react_comfort";
    case "board_point":
      return "board_point";
    case "farewell":
      return "idle_breathe";
  }
}

export function actionToEmotion(action: InstantAction): TutorEmotion {
  switch (action) {
    case "praise_thumbs_up":
    case "praise_clap":
      return "cheerful";
    case "gentle_encourage":
      return "warm";
    case "think_chin":
      return "curious";
    case "board_point":
      return "focused";
    case "empathy_nod":
    case "greet":
    case "farewell":
      return "warm";
  }
}

export function poseToClipSlot(pose: TutorPose, lectureVariant: 0 | 1): ClipSlot {
  switch (pose) {
    case "greeting":
      return "speak_explain_a";
    case "lecturing":
      return lectureVariant === 0 ? "speak_explain_a" : "speak_explain_b";
    case "board_guiding":
      return "board_point";
    case "listening_empathy":
      return "listen_nod";
    case "feedback_reaction":
      return "idle_breathe";
    case "idle_companion":
      return "idle_breathe";
  }
}

export type ChoreographerInput =
  | { type: "lesson_open"; gen: number }
  | { type: "speaking"; gen: number; seg?: number; emotion?: TutorEmotion; stage?: string }
  | { type: "board_point"; gen: number }
  | { type: "thinking"; gen: number }
  | { type: "waiting"; gen: number; nowMs: number }
  | { type: "listening"; gen: number }
  | { type: "instant_action"; gen: number; action: InstantAction }
  | { type: "action_complete"; gen: number }
  | { type: "interrupt"; gen: number }
  | { type: "learner_activity"; nowMs: number }
  | { type: "tick"; nowMs: number }
  | { type: "paused" };

export function reduceChoreographer(
  state: ChoreographerState,
  input: ChoreographerInput,
): ChoreographerState {
  if ("gen" in input && input.gen > 0 && input.gen < state.gen) {
    return state;
  }
  const nextGen = "gen" in input ? Math.max(state.gen, input.gen) : state.gen;

  switch (input.type) {
    case "lesson_open":
      return {
        ...state,
        gen: nextGen,
        pose: "greeting",
        emotion: "warm",
        clip: "speak_explain_a",
        activeAction: "greet",
        quietCompanion: false,
        waitingSinceMs: null,
      };
    case "speaking": {
      const isOpening = input.stage === "opening" && (input.seg ?? 1) <= 1;
      const variant: 0 | 1 =
        typeof input.seg === "number"
          ? ((Math.abs(input.seg) % 2) as 0 | 1)
          : state.lectureVariant === 0
            ? 1
            : 0;
      const pose: TutorPose = isOpening ? "greeting" : "lecturing";
      return {
        ...state,
        gen: nextGen,
        pose,
        emotion: input.emotion ?? state.emotion,
        lectureVariant: variant,
        clip: poseToClipSlot(pose, variant),
        activeAction: null,
        quietCompanion: false,
        waitingSinceMs: null,
      };
    }
    case "board_point":
      return {
        ...state,
        gen: nextGen,
        pose: "board_guiding",
        emotion: "focused",
        clip: "board_point",
        activeAction: "board_point",
        quietCompanion: false,
        waitingSinceMs: null,
      };
    case "thinking":
      return {
        ...state,
        gen: nextGen,
        pose: state.activeAction ? "feedback_reaction" : "idle_companion",
        emotion: "curious",
        clip: state.activeAction ? actionToClipSlot(state.activeAction) : "think_chin",
        quietCompanion: false,
        waitingSinceMs: null,
      };
    case "waiting":
      return {
        ...state,
        gen: nextGen,
        pose: state.quietCompanion ? "idle_companion" : "listening_empathy",
        clip: state.quietCompanion ? "idle_breathe" : "listen_nod",
        activeAction: null,
        waitingSinceMs: state.waitingSinceMs ?? input.nowMs,
      };
    case "listening":
      return {
        ...state,
        gen: nextGen,
        pose: "listening_empathy",
        emotion: "warm",
        clip: "listen_nod",
        activeAction: null,
        quietCompanion: false,
        waitingSinceMs: null,
      };
    case "instant_action": {
      const clip = actionToClipSlot(input.action);
      const pose: TutorPose =
        input.action === "board_point"
          ? "board_guiding"
          : input.action === "empathy_nod"
            ? "listening_empathy"
            : input.action === "greet"
              ? "greeting"
              : "feedback_reaction";
      return {
        ...state,
        gen: nextGen,
        pose,
        emotion: actionToEmotion(input.action),
        clip,
        activeAction: input.action,
        quietCompanion: false,
        waitingSinceMs: null,
      };
    }
    case "action_complete":
      return {
        ...state,
        activeAction: null,
        pose: state.pose === "board_guiding" ? "lecturing" : "listening_empathy",
        clip: state.pose === "board_guiding" ? poseToClipSlot("lecturing", state.lectureVariant) : "idle_breathe",
      };
    case "interrupt":
      return {
        ...state,
        gen: nextGen,
        pose: "listening_empathy",
        emotion: "warm",
        clip: "listen_nod",
        activeAction: null,
        quietCompanion: false,
        waitingSinceMs: null,
      };
    case "learner_activity":
      if (state.waitingSinceMs === null && !state.quietCompanion) return state;
      return {
        ...state,
        pose: "listening_empathy",
        clip: "listen_nod",
        quietCompanion: false,
        waitingSinceMs: input.nowMs,
      };
    case "tick":
      if (
        state.waitingSinceMs !== null &&
        !state.quietCompanion &&
        input.nowMs - state.waitingSinceMs >= IDLE_COMPANION_MS
      ) {
        return {
          ...state,
          pose: "idle_companion",
          clip: "idle_breathe",
          quietCompanion: true,
        };
      }
      return state;
    case "paused":
      return {
        ...state,
        pose: "idle_companion",
        clip: "idle_breathe",
        activeAction: null,
        quietCompanion: true,
        waitingSinceMs: null,
      };
  }
}
