import type { ClipSlot, InstantAction, LessonPhase, TutorEmotion, TutorPose } from "./types";

export const IDLE_COMPANION_MS = 15_000;
export const BOARD_GUIDE_HOLD_MS = 2_600;
export const REACTION_HOLD_MS = 2_800;

export const ONE_SHOT_CLIPS: ReadonlySet<ClipSlot> = new Set([
  "board_point",
  "react_praise",
  "react_comfort",
]);

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
    case "thinking":
      return "think_chin";
    case "feedback_reaction":
      return "idle_breathe";
    case "idle_companion":
      return "idle_breathe";
  }
}

export interface PhasePoseContext {
  quietCompanion?: boolean;
  instantAction?: InstantAction | null;
  boardGuiding?: boolean;
  isOpeningGreeting?: boolean;
  speaking?: boolean;
}

/**
 * Single canonical mapping from explicit LessonPhase to TutorPose.
 * Replaces the former unused reduceChoreographer state machine (DECISIONS.md U2a).
 */
export function phaseToTutorPose(phase: LessonPhase, ctx: PhasePoseContext = {}): TutorPose {
  if (ctx.instantAction) {
    if (ctx.instantAction === "board_point") return "board_guiding";
    if (ctx.instantAction === "think_chin") return "thinking";
    return "feedback_reaction";
  }
  switch (phase) {
    case "preparing":
    case "thinking":
    case "buffering":
      return "thinking";
    case "listening":
    case "judging":
      return "listening_empathy";
    case "awaiting":
      return ctx.quietCompanion ? "idle_companion" : "listening_empathy";
    case "speaking":
      if (ctx.boardGuiding) return "board_guiding";
      if (ctx.isOpeningGreeting) return "greeting";
      return "lecturing";
    case "feedback":
      if (ctx.speaking) {
        return ctx.boardGuiding ? "board_guiding" : "lecturing";
      }
      return "feedback_reaction";
    case "loading":
    case "lobby":
    case "connecting":
    case "paused":
    case "reconnecting":
    case "ending":
    case "ended":
    case "failed":
      return "idle_companion";
  }
}
