export interface AvatarBoardFocus {
  active?: boolean;
  id: string;
  x: number;
  y: number;
}

export type AvatarTeachingFeedbackKind =
  | "correct"
  | "retry"
  | "encourage"
  | "explain";

export interface AvatarTeachingFeedback {
  kind: AvatarTeachingFeedbackKind;
  sequence: number;
}

export type AvatarTeachingEmotion =
  | "neutral"
  | "warm"
  | "cheerful"
  | "curious"
  | "focused"
  | "playful"
  | "concerned";

export type AvatarGazeSource = "board" | "idle" | "pointer" | "reduced";

export interface AvatarGazeTarget {
  active: boolean;
  source: AvatarGazeSource;
  x: number;
  y: number;
}

function clampGaze(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

export function resolveAvatarGaze(input: {
  boardFocus?: AvatarBoardFocus | null;
  pointer?: { active: boolean; x: number; y: number } | null;
  reducedMotion: boolean;
}): AvatarGazeTarget {
  if (input.reducedMotion) {
    return { active: false, source: "reduced", x: 0, y: 0 };
  }
  if (input.boardFocus?.active !== false) {
    const boardFocus = input.boardFocus;
    if (boardFocus) {
      return {
        active: true,
        source: "board",
        x: clampGaze(boardFocus.x),
        y: clampGaze(boardFocus.y),
      };
    }
  }
  if (input.pointer?.active) {
    return {
      active: true,
      source: "pointer",
      x: clampGaze(input.pointer.x),
      y: clampGaze(input.pointer.y),
    };
  }
  return { active: false, source: "idle", x: 0, y: 0 };
}

export function teachingFeedbackReactionKey(
  feedback?: AvatarTeachingFeedback | null,
) {
  return feedback ? `teaching:${feedback.kind}:${feedback.sequence}` : null;
}

export function teachingFeedbackEmotion(
  feedback?: AvatarTeachingFeedback | null,
): AvatarTeachingEmotion | null {
  if (!feedback) return null;
  if (feedback.kind === "correct") return "cheerful";
  if (feedback.kind === "retry") return "concerned";
  if (feedback.kind === "encourage") return "warm";
  return "focused";
}
