import { describe, expect, it } from "vitest";
import {
  isJudgingActive,
  lessonPhase,
  phaseStatusKey,
  reconnectDelayMs,
  resolvePhasePose,
  type LessonPhaseInput,
} from "../src/features/classroom/lesson-phase";
import { advanceClassroom, initialClassroom } from "../src/features/classroom/lesson-state";
import { buildReplayTimeline, formatMediaTime, indexAtTimeMs } from "../src/features/replay/replay-timeline";
import type { LessonEvent } from "../src/features/classroom/timeline";

function evt(seq: number, gen: number, type: string, data: Record<string, unknown> = {}): LessonEvent {
  return {
    lesson_id: "lesson-1",
    seq,
    gen,
    t_ms: seq * 100,
    type,
    data,
  };
}

function baseInput(overrides: Partial<LessonPhaseInput> = {}): LessonPhaseInput {
  return {
    loading: false,
    preparing: false,
    connected: true,
    started: true,
    resuming: false,
    reconnectAttempt: 0,
    fatalError: false,
    recording: false,
    audioSpeaking: false,
    audioBuffering: false,
    audioMode: true,
    pendingSubmit: null,
    previewVerdict: null,
    classroom: initialClassroom,
    roomSeq: 0,
    hasFirstBeat: true,
    ending: false,
    ended: false,
    tabPaused: false,
    quietCompanion: false,
    errorSeq: 0,
    ...overrides,
  };
}

describe("lessonPhase explicit state machine (experience-design §5.6.2)", () => {
  it("enters lobby on first visit (never paused) and paused only if lesson started previously", () => {
    expect(lessonPhase(baseInput({ started: false, roomSeq: 0, hasFirstBeat: false }))).toBe("lobby");
    expect(lessonPhase(baseInput({ started: false, roomSeq: 3, hasFirstBeat: true }))).toBe("paused");
    expect(lessonPhase(baseInput({ started: false, tabPaused: true, roomSeq: 0, hasFirstBeat: false }))).toBe("paused");
  });

  it("distinguishes buffering from speaking so avatar never speaks before audio starts", () => {
    const buffering = lessonPhase(baseInput({ audioBuffering: true, audioSpeaking: false }));
    expect(buffering).toBe("buffering");
    expect(
      resolvePhasePose(buffering, {
        quietCompanion: false,
        instantAction: null,
        classroom: initialClassroom,
        audioSpeaking: false,
      }),
    ).toBe("thinking");

    const speaking = lessonPhase(baseInput({ audioBuffering: false, audioSpeaking: true }));
    expect(speaking).toBe("speaking");
    expect(
      resolvePhasePose(speaking, {
        quietCompanion: false,
        instantAction: null,
        classroom: initialClassroom,
        audioSpeaking: true,
      }),
    ).toBe("greeting");
  });

  it("covers voice mode with judge.preview exiting judging immediately into feedback", () => {
    let state = advanceClassroom(initialClassroom, evt(1, 1, "ask", {
      kind: "item",
      purpose: "check",
      item_id: "q1",
      widget: { type: "choice", stem: "Pick A", options: [{ key: "A", text: "Yes" }, { key: "B", text: "No" }] },
    }));

    // Student submits objective answer -> enters judging
    const submit = { itemId: "q1", askSeq: 1, errorSeq: 0, submittedAtMs: 1000 };
    expect(lessonPhase(baseInput({ classroom: state, pendingSubmit: submit }))).toBe("judging");
    expect(phaseStatusKey("judging", false)).toBe("judging");

    // Judge preview arrives before realizer finishes -> leaves judging into feedback
    expect(
      lessonPhase(baseInput({
        classroom: state,
        pendingSubmit: submit,
        previewVerdict: { askSeq: 1, verdict: "correct" },
      })),
    ).toBe("feedback");

    // Full judge event arrives, followed by beat.start -> remains in feedback (never awaiting!)
    state = advanceClassroom(state, evt(2, 1, "judge", { verdict: "correct" }));
    state = advanceClassroom(state, evt(3, 2, "beat.start", { move: "TEACH" }));
    expect(state.judge).toBe("correct");
    expect(lessonPhase(baseInput({ classroom: state, pendingSubmit: submit, audioSpeaking: true }))).toBe("feedback");
  });

  it("covers text mode where audioMode=false and speaking is true during caption dwell", () => {
    const state = advanceClassroom(initialClassroom, evt(1, 1, "say", { text: "先看条件", seg: 1 }));
    expect(
      lessonPhase(baseInput({
        audioMode: false,
        audioSpeaking: true,
        classroom: state,
      })),
    ).toBe("speaking");
    expect(state.spokenLog).toHaveLength(1);
    expect(state.spokenLog[0]?.text).toBe("先看条件");
  });

  it("unlocks tray and returns to awaiting when error occurs or 20s judging timeout fires", () => {
    const state = advanceClassroom(initialClassroom, evt(1, 1, "ask", {
      kind: "item",
      purpose: "check",
      item_id: "q1",
      widget: { type: "choice", stem: "Pick A", options: [{ key: "A", text: "Yes" }] },
    }));
    const submit = { itemId: "q1", askSeq: 1, errorSeq: 2, submittedAtMs: 1000 };

    // Error arrives (errorSeq increments to 3) -> exits judging back to awaiting
    expect(isJudgingActive({ pendingSubmit: submit, previewVerdict: null, classroom: state, audioSpeaking: false, errorSeq: 3 })).toBe(false);
    expect(lessonPhase(baseInput({ classroom: state, pendingSubmit: submit, errorSeq: 3 }))).toBe("awaiting");

    // 20s timeout fires -> exits judging back to awaiting
    expect(lessonPhase(baseInput({
      classroom: state,
      pendingSubmit: { ...submit, timedOut: true },
      errorSeq: 2,
    }))).toBe("awaiting");
  });

  it("does not enter judging for ack questions and clears judge when the same item is re-asked", () => {
    const ackState = advanceClassroom(initialClassroom, evt(1, 1, "ask", {
      kind: "ack",
      purpose: "continue",
    }));
    expect(lessonPhase(baseInput({ classroom: ackState, pendingSubmit: null }))).toBe("awaiting");

    // Same item re-asked after incorrect verdict clears judge cleanly
    let state = advanceClassroom(initialClassroom, evt(1, 1, "ask", {
      kind: "item",
      purpose: "check",
      item_id: "q1",
      widget: { type: "choice", stem: "Try again", options: [{ key: "A", text: "1" }, { key: "B", text: "2" }] },
    }));
    state = advanceClassroom(state, evt(2, 1, "judge", { verdict: "incorrect" }));
    expect(state.judge).toBe("incorrect");
    // Re-asking q1 without beat.start still clears judge because judge was set
    state = advanceClassroom(state, evt(3, 2, "ask", {
      kind: "item",
      purpose: "check",
      item_id: "q1",
      widget: { type: "choice", stem: "Try again", options: [{ key: "A", text: "1" }, { key: "B", text: "2" }] },
    }));
    expect(state.judge).toBeUndefined();
    expect(state.askSeq).toBe(3);
    expect(lessonPhase(baseInput({ classroom: state }))).toBe("awaiting");
  });

  it("handles show_answer (judge without verdict) and partial verdict properly", () => {
    let state = advanceClassroom(initialClassroom, evt(1, 1, "ask", {
      kind: "item",
      purpose: "check",
      item_id: "q1",
      widget: { type: "choice", stem: "Pick", options: [{ key: "A", text: "1" }] },
    }));

    // show_answer returns answer without verdict -> stays awaiting, stores revealedAnswer
    state = advanceClassroom(state, evt(2, 1, "judge", { answer: "A" }));
    expect(state.judge).toBeUndefined();
    expect(state.revealedAnswer).toBe("A");
    expect(lessonPhase(baseInput({ classroom: state }))).toBe("awaiting");

    // partial verdict enters feedback with non-praise comfort action
    state = advanceClassroom(state, evt(3, 1, "judge", { verdict: "partial" }));
    expect(state.judge).toBe("partial");
    expect(state.avatar.instantAction).toBe("gentle_encourage");
    expect(lessonPhase(baseInput({ classroom: state }))).toBe("feedback");
  });

  it("inserts adaptation and stage dividers on beat.start and state transitions", () => {
    let state = advanceClassroom(initialClassroom, evt(1, 1, "state", { stage: "teaching", paused: false }));
    expect(state.dividers.some((d) => d.kind === "stage" && d.stage === "teaching")).toBe(true);
    state = advanceClassroom(state, evt(2, 2, "beat.start", { move: "REEXPLAIN", style: "analogy", attempt: 2 }));
    expect(state.dividers.some((d) => d.kind === "reexplain" && d.style === "analogy" && d.repeat === 2)).toBe(true);
    state = advanceClassroom(state, evt(3, 3, "beat.start", { move: "PREREQ_REMEDIATE", kp_name: "导数定义" }));
    expect(state.dividers.some((d) => d.kind === "prereq" && d.kpName === "导数定义")).toBe(true);
  });

  it("uses unbounded exponential backoff capped at 15s and builds time-based replay timelines", () => {
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBeGreaterThan(reconnectDelayMs(1));
    expect(reconnectDelayMs(5)).toBeLessThanOrEqual(15_000);
    expect(reconnectDelayMs(100)).toBe(15_000);

    const sampleEvents = [
      evt(1, 1, "beat.start", { move: "OPEN" }),
      evt(2, 1, "say", { text: "先确认已知条件。", seg: 1 }),
      evt(3, 1, "board", { id: "b1", type: "text", content: "条件" }),
      evt(4, 1, "say", { text: "接下来我们一步步看结论。", seg: 2 }),
    ];
    const timeline = buildReplayTimeline(sampleEvents);
    expect(timeline.offsetsMs).toHaveLength(5);
    expect(timeline.totalMs).toBeGreaterThan(2000);
    expect(indexAtTimeMs(timeline, 0)).toBe(0);
    expect(indexAtTimeMs(timeline, timeline.totalMs)).toBe(4);
    expect(formatMediaTime(65_000)).toBe("01:05");
  });
});
