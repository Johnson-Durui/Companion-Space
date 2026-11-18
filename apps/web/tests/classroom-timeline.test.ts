import { describe, expect, it } from "vitest";
import { Timeline, type LessonEvent } from "../src/features/classroom/timeline";
import { advanceClassroom, initialClassroom, restoreClassroom } from "../src/features/classroom/lesson-state";
import { boardMarkdown } from "../src/features/classroom/board";

function event(seq: number, type = "say", gen = 1, data: Record<string, unknown> = {}): LessonEvent {
  return { lesson_id: "lesson", seq, gen, type, data, t_ms: 0 };
}

describe("classroom timeline", () => {
  it("executes all permutations in lesson order", async () => {
    for (const start of [0, 1, 2]) {
      for (const next of [1, 2]) {
        const order = [1, 2, 3];
        [order[0], order[start]] = [order[start], order[0]];
        [order[1], order[next]] = [order[next], order[1]];
        const seen: number[] = [];
        await new Promise<void>((resolve, reject) => {
          const timeline = new Timeline(0, async (row) => {
            seen.push(row.seq);
            if (seen.length === order.length) resolve();
          }, reject);
          order.forEach((seq) => timeline.append(event(seq)));
        });
        expect(seen).toEqual([1, 2, 3]);
      }
    }
  });

  it("aborts the audible sentence and drops later actions from that generation", async () => {
    const actions: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeline = new Timeline(3, async (row, signal) => {
        if (row.type === "say") {
          await new Promise<void>((finish) => signal.addEventListener("abort", () => {
            actions.push("stopped");
            finish();
          }, { once: true }));
        } else actions.push(row.type);
        if (row.gen === 2) resolve();
      }, reject);
      timeline.append(event(4));
      expect(timeline.heardSeq).toBe(3);
      timeline.append(event(5, "board"));
      timeline.append(event(6, "ask"));
      timeline.append(event(7, "beat.cancelled"));
      timeline.append(event(8, "ask"));
      timeline.append(event(9, "beat.start", 2));
    });
    expect(actions).toEqual(["stopped", "beat.cancelled", "ask", "beat.start"]);
  });

  it("replays a cancelled beat only through the hearing checkpoint", () => {
    const events = [
      event(1, "board", 1, { op: "add", id: "visible", type: "text", content: "first" }),
      event(2, "board", 1, { op: "add", id: "unheard", type: "text", content: "second" }),
      event(3, "beat.cancelled", 1, { heard_seq: 1 }),
      event(4, "board", 2, { op: "append", target: "visible", content: "next" }),
    ];
    const board = restoreClassroom(events, 4).board;
    expect(board.map(({ content }) => content)).toEqual(["first\nnext"]);
    expect(boardMarkdown(board)).toBe("first\nnext\n");
  });

  it("keeps the same question identity when reconnecting reissues it", () => {
    const question = { kind: "item", purpose: "check", item_id: "question" };
    const answered = advanceClassroom(initialClassroom, event(3, "ask", 1, question));
    const resumed = advanceClassroom(answered, event(4, "ask", 1, question));
    expect(resumed.askSeq).toBe(3);
    const newBeat = advanceClassroom(resumed, event(5, "beat.start", 2));
    expect(advanceClassroom(newBeat, event(6, "ask", 2, question)).askSeq).toBe(6);
  });

  it("drives avatar gaze, expression, and answer reactions from lesson events", () => {
    const speaking = advanceClassroom(initialClassroom, event(1, "say", 1, { emotion: "warm", text: "hello" }));
    expect(speaking.avatar.emotion).toBe("warm");

    const pointing = advanceClassroom(speaking, event(2, "point", 1, { target: "b1.2" }));
    expect(pointing.avatar.gaze.active).toBe(true);
    expect(pointing.avatar.gestureSequence).toBe(2);

    const correct = advanceClassroom(pointing, event(3, "judge", 1, { verdict: "correct" }));
    expect(correct.avatar.emotion).toBe("cheerful");
    expect(correct.avatar.reactionKey).toBe("teaching:correct:3");

    const retry = advanceClassroom(correct, event(4, "judge", 1, { verdict: "incorrect" }));
    expect(retry.avatar.emotion).toBe("concerned");
    expect(retry.avatar.reactionKey).toBe("teaching:retry:4");
  });
});
