import { ONE_SHOT_CLIPS } from "./catalog";
import type {
  ClipSlot,
  InstantAction,
  LessonPhase,
  OneShotKind,
  Situation,
  StillSlot,
  TutorEmotion,
  TutorPose,
} from "./types";

export { ONE_SHOT_CLIPS };

export const IDLE_COMPANION_MS = 15_000;
export const BOARD_GUIDE_HOLD_MS = 2_600;
export const REACTION_HOLD_MS = 2_800;

export function quickActionToInstantAction(kind: string): InstantAction | null {
  if (kind === "confused" || kind === "slower" || kind === "repeat") return "gentle_encourage";
  if (kind === "hint" || kind === "example") return "think_chin";
  if (kind === "show_answer" || kind.startsWith("locate:")) return "board_point";
  if (kind === "break") return "empathy_nod";
  return null;
}

export function quickActionToOneShot(kind: string): OneShotKind | null {
  if (kind === "confused" || kind === "slower" || kind === "repeat") return "comfort";
  if (kind === "hint" || kind === "example") return "hint";
  if (kind === "show_answer" || kind.startsWith("locate:")) return "board_point";
  if (kind === "break") return "ack";
  return null;
}

export function verdictToInstantAction(verdict: string | undefined): InstantAction | null {
  if (!verdict) return null;
  if (verdict === "correct") return "praise_thumbs_up";
  return "gentle_encourage";
}

export function verdictToOneShot(verdict: string | undefined, consecutiveCorrect = 0): OneShotKind | null {
  if (!verdict) return null;
  if (verdict === "correct") {
    return consecutiveCorrect >= 3 && consecutiveCorrect % 3 === 0 ? "surprise" : "praise";
  }
  return "comfort";
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
 * Legacy Pose mapping retained for compatibility with Static/LocalSidecar/CloudLive drivers.
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

export interface PhaseSituationContext {
  speaking?: boolean;
  hasBoardEvent?: boolean;
  quietCompanion?: boolean;
  typingRecently?: boolean;
  sentenceSeq?: number;
}

/**
 * Canonical mapping from LessonPhase + runtime context to tutor media Situation (spec/tutor-media.md §4.1).
 */
export function phaseToSituation(phase: LessonPhase, ctx: PhaseSituationContext = {}): Situation {
  switch (phase) {
    case "loading":
      return "loading";
    case "preparing":
      return "preparing";
    case "lobby":
    case "connecting":
      return "idle";
    case "thinking":
      return ctx.typingRecently ? "listening" : "thinking";
    case "buffering":
      return "thinking";
    case "speaking":
      return ctx.hasBoardEvent ? "speaking_board" : "speaking";
    case "feedback":
      if (ctx.speaking) {
        return ctx.hasBoardEvent ? "speaking_board" : "speaking";
      }
      return "idle";
    case "listening":
      return "listening";
    case "awaiting":
      if (ctx.typingRecently) return "listening";
      return ctx.quietCompanion ? "idle" : "wait";
    case "judging":
      return "review";
    case "paused":
      return "paused";
    case "reconnecting":
    case "failed":
      return "frozen";
    case "ending":
    case "ended":
      return "ended";
  }
}

/** Compatibility downgrade from Situation to legacy TutorPose (§4.0). */
export function situationToTutorPose(situation: Situation): TutorPose {
  switch (situation) {
    case "preparing":
    case "thinking":
      return "thinking";
    case "listening":
    case "wait":
    case "review":
      return "listening_empathy";
    case "speaking":
      return "lecturing";
    case "speaking_board":
      return "board_guiding";
    case "loading":
    case "idle":
    case "paused":
    case "frozen":
    case "ended":
      return "idle_companion";
  }
}

/** Compatibility downgrade from OneShotKind to legacy InstantAction (§4.0). */
export function oneShotToInstantAction(kind: OneShotKind): InstantAction | null {
  switch (kind) {
    case "greet":
      return "greet";
    case "farewell":
      return "farewell";
    case "ack":
      return "empathy_nod";
    case "hint":
      return "think_chin";
    case "comfort":
    case "encourage":
      return "gentle_encourage";
    case "celebrate":
      return "praise_clap";
    case "praise":
    case "surprise":
      return "praise_thumbs_up";
    case "board_point":
      return "board_point";
    case "board_glance":
      return null;
  }
}

/** Map Situation + active OneShotKind to desired still expression key (§4.6). */
export function resolveDesiredStill(
  situation: Situation,
  oneShot: OneShotKind | null,
): StillSlot | "anchor" {
  if (oneShot) {
    switch (oneShot) {
      case "praise":
      case "surprise":
      case "celebrate":
        return "praise";
      case "comfort":
      case "encourage":
        return "caring";
      case "hint":
        return "playful";
      case "greet":
        return "cheerful";
      case "board_point":
      case "board_glance":
        return "focused";
      case "ack":
      case "farewell":
        break;
    }
  }
  switch (situation) {
    case "ended":
      return "praise";
    case "wait":
      return "curious";
    case "review":
    case "preparing":
    case "speaking_board":
      return "focused";
    case "thinking":
      return "thinking";
    case "loading":
    case "idle":
    case "speaking":
    case "listening":
    case "paused":
    case "frozen":
      return "anchor";
  }
}

/** Map legacy InstantAction / TutorPose to desired still expression key when setSituation is not used. */
export function legacyPoseActionToStill(
  pose: TutorPose,
  action: InstantAction | null,
): StillSlot | "anchor" {
  if (action) {
    switch (action) {
      case "praise_thumbs_up":
      case "praise_clap":
        return "praise";
      case "gentle_encourage":
        return "caring";
      case "think_chin":
        return "thinking";
      case "board_point":
        return "focused";
      case "greet":
        return "cheerful";
      case "empathy_nod":
      case "farewell":
        break;
    }
  }
  switch (pose) {
    case "thinking":
      return "thinking";
    case "board_guiding":
      return "focused";
    case "listening_empathy":
      return "curious";
    case "greeting":
      return "cheerful";
    case "lecturing":
    case "feedback_reaction":
    case "idle_companion":
      return "anchor";
  }
}

export function resolveStillUrl(
  stills: Partial<Record<StillSlot, string>> | undefined,
  anchorImage: string,
  desired: StillSlot | "anchor",
): { still: StillSlot | "anchor"; url: string } {
  if (desired === "anchor" || !stills) {
    return { still: "anchor", url: anchorImage };
  }
  if (stills[desired]) {
    return { still: desired, url: stills[desired]! };
  }
  if (desired === "praise" && stills.cheerful) {
    return { still: "cheerful", url: stills.cheerful };
  }
  return { still: "anchor", url: anchorImage };
}
