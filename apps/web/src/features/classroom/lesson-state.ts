import { applyBoardEvent, type Block } from "./board";
import type { LessonEvent } from "./timeline";

export type Ask = {
  kind: string;
  purpose: string;
  item_id?: string;
  widget?: { type: string; stem: string; options: { key: string; text: string }[] };
};
export type Prefill = { item_id: string; value: string | string[]; via: "voice" | "text" };

export type ClassroomState = {
  board: readonly Block[];
  caption: string;
  ask?: Ask;
  askSeq?: number;
  judge?: string;
  stage: string;
  paused: boolean;
};

export const initialClassroom: ClassroomState = { board: [], caption: "", stage: "opening", paused: false };

export function advanceClassroom(state: ClassroomState, event: LessonEvent): ClassroomState {
  const { data } = event;
  switch (event.type) {
    case "board":
    case "mark":
      return { ...state, board: applyBoardEvent(state.board, event) };
    case "say":
      return { ...state, caption: String(data.text ?? "") };
    case "beat.start":
      return { ...state, ask: undefined, caption: "" };
    case "ask":
      return { ...state, ask: data as Ask, askSeq: state.ask?.item_id === data.item_id && state.ask?.purpose === data.purpose
        ? state.askSeq : event.seq };
    case "judge":
      return { ...state, judge: typeof data.verdict === "string" ? data.verdict : undefined };
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
