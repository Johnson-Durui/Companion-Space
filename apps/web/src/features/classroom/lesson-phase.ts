import type { InstantAction, LessonPhase, TutorPose } from "@companion-space/avatar-engine/types";
import { phaseToTutorPose } from "@companion-space/avatar-engine/choreographer";
import type { Ask, ClassroomState } from "./lesson-state";

export const JUDGING_TIMEOUT_MS = 20_000;
export const TAB_AWAY_PAUSE_MS = 30_000;

/** Unbounded exponential backoff capped at 15 seconds (§5.6.12). */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, attempt - 1);
  return Math.min(15_000, Math.round(500 * Math.pow(1.6, Math.min(step, 10))));
}

export interface PendingSubmit {
  itemId: string;
  askSeq: number;
  errorSeq: number;
  submittedAtMs: number;
  timedOut?: boolean;
}

export interface LessonPhaseInput {
  loading: boolean;
  preparing?: boolean;
  connected: boolean;
  started: boolean;
  resuming: boolean;
  reconnectAttempt: number;
  fatalError: boolean;
  recording: boolean;
  audioSpeaking: boolean;
  audioBuffering: boolean;
  audioMode: boolean;
  pendingSubmit: PendingSubmit | null;
  previewVerdict?: { askSeq: number; verdict: string } | null;
  classroom: ClassroomState;
  roomSeq: number;
  hasFirstBeat?: boolean;
  ending: boolean;
  ended: boolean;
  tabPaused?: boolean;
  quietCompanion: boolean;
  errorSeq: number;
}

export function isAckAsk(ask?: Ask): boolean {
  return Boolean(ask && (ask.kind === "ack" || !ask.item_id));
}

export function isObjectiveAsk(ask?: Ask): boolean {
  return Boolean(ask?.item_id && ask.widget && ask.widget.options.length > 0);
}

export function isOpenEndedAsk(ask?: Ask): boolean {
  return Boolean(ask && !isAckAsk(ask) && (!ask.widget || ask.widget.options.length === 0));
}

export function isJudgingActive(input: Pick<
  LessonPhaseInput,
  "pendingSubmit" | "previewVerdict" | "classroom" | "audioSpeaking" | "errorSeq"
>): boolean {
  const { pendingSubmit, previewVerdict, classroom, audioSpeaking, errorSeq } = input;
  if (!pendingSubmit) return false;
  // Exit 4: timed out after 20s
  if (pendingSubmit.timedOut) return false;
  // Exit 3: error received after submit
  if (errorSeq > pendingSubmit.errorSeq) return false;
  // Exit 1: judge or judge.preview arrived for this ask
  if (classroom.judge) return false;
  if (previewVerdict && previewVerdict.askSeq === pendingSubmit.askSeq) return false;
  // Exit 2: beat moved on (ask cleared or askSeq changed or teacher already started speaking next beat)
  if (!classroom.ask || classroom.askSeq !== pendingSubmit.askSeq) return false;
  if (audioSpeaking) return false;
  return true;
}

/**
 * Pure explicit classroom phase state machine (experience-design.md §5.6.2).
 * All UI states (status pill, avatar pose, caption area, answer tray, dock)
 * derive solely from this phase.
 */
export function lessonPhase(input: LessonPhaseInput): LessonPhase {
  if (input.ended) return "ended";
  if (input.ending) return "ending";
  if (input.loading) return "loading";
  if (input.preparing) return "preparing";
  if (input.fatalError) return "failed";

  if (!input.connected) {
    if (input.reconnectAttempt > 0 || input.started) return "reconnecting";
    if (!input.started) return "connecting";
  }

  const hasStartedBefore = input.classroom.paused || input.roomSeq > 0 || Boolean(input.hasFirstBeat) || Boolean(input.tabPaused);

  if (!input.started) {
    return hasStartedBefore ? "paused" : "lobby";
  }

  if (input.resuming && !input.audioSpeaking && !input.classroom.ask && !input.classroom.judge) {
    return "connecting";
  }

  if (input.recording) return "listening";

  if (isJudgingActive(input)) return "judging";

  const hasVerdict = Boolean(
    input.classroom.judge
    || (input.previewVerdict && input.classroom.askSeq !== undefined && input.previewVerdict.askSeq === input.classroom.askSeq),
  );
  if (hasVerdict) {
    return "feedback";
  }

  if (input.audioSpeaking) return "speaking";

  if (input.audioBuffering) return "buffering";

  if (input.classroom.ask) return "awaiting";

  return "thinking";
}

export type PhaseStatusKey =
  | "connecting"
  | "preparing"
  | "waitingStart"
  | "paused"
  | "listening"
  | "speaking"
  | "thinking"
  | "waiting"
  | "quietCompanion"
  | "judging"
  | "reconnecting"
  | "ending"
  | "failed";

export function phaseStatusKey(phase: LessonPhase, quietCompanion: boolean): PhaseStatusKey {
  switch (phase) {
    case "loading":
    case "connecting":
      return "connecting";
    case "preparing":
      return "preparing";
    case "lobby":
      return "waitingStart";
    case "paused":
      return "paused";
    case "listening":
      return "listening";
    case "speaking":
    case "feedback":
      return "speaking";
    case "thinking":
    case "buffering":
      return "thinking";
    case "awaiting":
      return quietCompanion ? "quietCompanion" : "waiting";
    case "judging":
      return "judging";
    case "reconnecting":
      return "reconnecting";
    case "ending":
    case "ended":
      return "ending";
    case "failed":
      return "failed";
  }
}

export function resolvePhasePose(
  phase: LessonPhase,
  input: {
    quietCompanion: boolean;
    instantAction: InstantAction | null;
    classroom: ClassroomState;
    audioSpeaking: boolean;
  },
): TutorPose {
  return phaseToTutorPose(phase, {
    quietCompanion: input.quietCompanion,
    instantAction: input.instantAction,
    boardGuiding: input.classroom.avatar.pose === "board_guiding",
    isOpeningGreeting: input.classroom.stage === "opening" && input.classroom.avatar.seg <= 1,
    speaking: input.audioSpeaking,
  });
}
