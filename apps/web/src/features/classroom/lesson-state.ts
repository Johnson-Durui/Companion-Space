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

export type BoardDivider = {
  id: string;
  afterBlockCount: number;
  kind: "stage" | "reexplain" | "prereq" | "return";
  stage?: string;
  style?: string;
  kpName?: string;
  repeat?: number;
};

export type SpokenEntry = {
  id: string;
  role: "teacher" | "student";
  text: string;
  badge?: "voice" | "text" | "quick";
  seq?: number;
};

export type AnsweredCard = {
  id: string;
  afterBlockCount: number;
  stem: string;
  verdict: string;
  studentAnswer?: string;
  correctAnswer?: string;
};

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
  revealedAnswer?: string;
  stage: string;
  segIdx: number;
  kpCursor: number;
  paused: boolean;
  lastMove?: string;
  lastStyle?: string;
  activeBlockId?: string;
  dividers: readonly BoardDivider[];
  spokenLog: readonly SpokenEntry[];
  answeredCards: readonly AnsweredCard[];
  pendingAnswered?: { stem: string; itemId?: string };
  avatar: AvatarState;
};

export const initialClassroom: ClassroomState = {
  board: [],
  caption: "",
  stage: "opening",
  segIdx: 0,
  kpCursor: 0,
  paused: false,
  dividers: [],
  spokenLog: [],
  answeredCards: [],
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

function appendSpoken(log: readonly SpokenEntry[], entry: SpokenEntry): readonly SpokenEntry[] {
  if (!entry.text.trim()) return log;
  if (log.some((item) => item.id === entry.id)) return log;
  const last = log[log.length - 1];
  if (last && last.role === entry.role && last.text === entry.text && entry.seq && last.seq === entry.seq) {
    return log;
  }
  return [...log.slice(-199), entry];
}

function appendDivider(dividers: readonly BoardDivider[], divider: BoardDivider): readonly BoardDivider[] {
  if (dividers.some((item) => item.id === divider.id)) return dividers;
  return [...dividers, divider];
}

export function advanceClassroom(state: ClassroomState, event: LessonEvent): ClassroomState {
  const { data } = event;
  const gen = Math.max(state.avatar.gen, event.gen);
  switch (event.type) {
    case "board":
    case "mark": {
      const nextBoard = applyBoardEvent(state.board, event);
      const targetId =
        typeof data.id === "string"
          ? data.id
          : typeof data.block_id === "string"
            ? data.block_id
            : nextBoard[nextBoard.length - 1]?.id;
      return {
        ...state,
        board: nextBoard,
        activeBlockId: targetId ?? state.activeBlockId,
        avatar: {
          ...state.avatar,
          gen,
          pose: "board_guiding",
          gaze: { active: true, x: 0.72, y: 0.05 },
        },
      };
    }
    case "say": {
      const text = String(data.text ?? "");
      const seg = typeof data.seg === "number" ? data.seg : state.avatar.seg + 1;
      const pose: TutorPose = state.stage === "opening" && seg <= 1 ? "greeting" : "lecturing";
      return {
        ...state,
        caption: text,
        spokenLog: appendSpoken(state.spokenLog, {
          id: `t:${event.gen}:${seg}:${event.seq}`,
          role: "teacher",
          text,
          seq: event.seq,
        }),
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
    case "point": {
      const nextBoard = applyBoardEvent(state.board, event);
      const targetId = typeof data.target === "string" ? data.target.split(".")[0] : state.activeBlockId;
      return {
        ...state,
        board: nextBoard,
        activeBlockId: targetId,
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
    }
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
    case "beat.start": {
      const move = typeof data.move === "string" ? data.move : undefined;
      const style = typeof data.style === "string" ? data.style : typeof data.style_id === "string" ? data.style_id : undefined;
      const kpName = typeof data.kp_name === "string" ? data.kp_name : undefined;
      const repeat = typeof data.attempt === "number" && data.attempt > 1 ? data.attempt : undefined;
      let dividers = state.dividers;
      if (move === "REEXPLAIN" || (style && state.lastStyle && style !== state.lastStyle)) {
        dividers = appendDivider(dividers, {
          id: `div:adapt:${event.seq}`,
          afterBlockCount: state.board.length,
          kind: "reexplain",
          style: style ?? state.lastStyle,
          repeat,
        });
      } else if (move === "PREREQ_REMEDIATE" || move === "REMEDIATE") {
        dividers = appendDivider(dividers, {
          id: `div:prereq:${event.seq}`,
          afterBlockCount: state.board.length,
          kind: "prereq",
          kpName,
        });
      } else if (move === "RETURN_FROM_REMEDIATE" || move === "RETURN") {
        dividers = appendDivider(dividers, {
          id: `div:return:${event.seq}`,
          afterBlockCount: state.board.length,
          kind: "return",
        });
      }
      return {
        ...state,
        ask: undefined,
        caption: "",
        lastMove: move ?? state.lastMove,
        lastStyle: style ?? state.lastStyle,
        dividers,
        avatar: { ...state.avatar, gen, seg: 0, instantAction: null },
      };
    }
    case "ask": {
      const askData = data as Ask;
      const sameAsk =
        !state.judge
        && state.ask?.item_id === askData.item_id
        && state.ask?.purpose === askData.purpose;
      return {
        ...state,
        ask: askData,
        askSeq: sameAsk ? state.askSeq : event.seq,
        judge: sameAsk ? state.judge : undefined,
        revealedAnswer: sameAsk ? state.revealedAnswer : undefined,
        pendingAnswered: askData.widget?.stem
          ? { stem: askData.widget.stem, itemId: askData.item_id }
          : undefined,
        avatar: { ...state.avatar, gen, pose: "listening_empathy" },
      };
    }
    case "judge": {
      const verdict = typeof data.verdict === "string" && data.verdict.trim() ? data.verdict : undefined;
      const revealed =
        typeof data.answer === "string"
          ? data.answer
          : typeof data.expected === "string"
            ? data.expected
            : typeof data.solution === "string"
              ? data.solution
              : undefined;
      // Show-answer judge without verdict reveals answer in tray without overwriting verdict.
      if (!verdict) {
        if (!revealed) return state;
        return { ...state, revealedAnswer: revealed };
      }
      const correct = verdict === "correct";
      const stem = state.ask?.widget?.stem ?? state.pendingAnswered?.stem;
      const studentVal = typeof data.value === "string" ? data.value : Array.isArray(data.value) ? data.value.join(", ") : undefined;
      const cardId = `ans:${event.seq}`;
      const answeredCards =
        stem && !state.answeredCards.some((card) => card.id === cardId)
          ? [
              ...state.answeredCards,
              {
                id: cardId,
                afterBlockCount: state.board.length,
                stem,
                verdict,
                studentAnswer: studentVal,
                correctAnswer: revealed,
              },
            ]
          : state.answeredCards;
      return {
        ...state,
        judge: verdict,
        revealedAnswer: revealed ?? state.revealedAnswer,
        answeredCards,
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
    case "state": {
      const nextStage = String(data.stage ?? state.stage);
      const stageChanged = nextStage !== state.stage && nextStage !== "done";
      const dividers = stageChanged
        ? appendDivider(state.dividers, {
            id: `div:stage:${nextStage}:${event.seq}`,
            afterBlockCount: state.board.length,
            kind: "stage",
            stage: nextStage,
          })
        : state.dividers;
      const nextStyle = typeof data.style_id === "string" ? data.style_id : state.lastStyle;
      const nextSegIdx = typeof data.seg_idx === "number" ? data.seg_idx : state.segIdx;
      const nextKpCursor = typeof data.kp_cursor === "number" ? data.kp_cursor : state.kpCursor;
      return {
        ...state,
        stage: nextStage,
        segIdx: nextSegIdx,
        kpCursor: nextKpCursor,
        paused: data.paused === true,
        lastStyle: nextStyle,
        dividers,
        avatar: data.paused === true ? { ...state.avatar, gen, pose: "idle_companion" } : { ...state.avatar, gen },
      };
    }
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

export type SubmissionLock = { askSeq: number; errorSeq: number };

export function isSubmissionLocked(
  submission: SubmissionLock | null,
  askSeq: number | undefined,
  errorSeq: number,
): boolean {
  return Boolean(
    submission
    && askSeq !== undefined
    && submission.askSeq === askSeq
    && submission.errorSeq === errorSeq,
  );
}

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
        ? (instantAction === "board_point" ? "board_guiding" : instantAction === "think_chin" ? "thinking" : "feedback_reaction")
        : speaking
          ? (classroom.avatar.pose === "board_guiding"
            ? "board_guiding"
            : classroom.stage === "opening" && classroom.avatar.seg <= 1
              ? "greeting"
              : "lecturing")
          : awaitingAnswer
            ? (quietCompanion ? "idle_companion" : "listening_empathy")
            : "thinking";

  return { awaitingAnswer, statusKey, pose };
}
