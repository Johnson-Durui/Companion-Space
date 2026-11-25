// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardBlock, nextRevealCount, normalizeMarkStyle, type Block } from "@companion-space/board";
import { classifyMicrophoneError, MicrophoneCapture, SOUND_CUE_DEDUP_MS, SoundCuePlayer } from "../src/audio";
import { BoardPanel } from "../src/features/classroom/board-panel";
import {
  advanceClassroom,
  initialClassroom,
  mergeTranscriptEntries,
  type SpokenEntry,
} from "../src/features/classroom/lesson-state";
import type { LessonEvent } from "../src/features/classroom/timeline";
import { TranscriptPanel } from "../src/features/classroom/transcript-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function event(seq: number, type: string, data: Record<string, unknown> = {}, gen = 1): LessonEvent {
  return { lesson_id: "lesson-u6", seq, gen, type, data, t_ms: seq * 100 };
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("U6 whiteboard depth: pagination, progressive steps, marks, line pointer & text locate", () => {
  it("preserves prior pages across clear events and lets students flip back in BoardPanel", () => {
    let state = advanceClassroom(
      initialClassroom,
      event(1, "board", { op: "add", id: "p1-b1", type: "text", content: "第一页核心公式" }),
    );
    state = advanceClassroom(state, event(2, "board", { op: "clear" }));
    state = advanceClassroom(
      state,
      event(3, "board", { op: "add", id: "p2-b1", type: "text", content: "第二页例题推导" }),
    );

    expect(state.boardPages).toHaveLength(2);
    expect(state.boardPages[0]?.blocks[0]?.content).toBe("第一页核心公式");
    expect(state.boardPages[1]?.blocks[0]?.content).toBe("第二页例题推导");

    const host = mount(
      <BoardPanel
        title="微积分课堂"
        stage="teaching"
        board={[...state.board]}
        pages={state.boardPages}
        dividers={[...state.dividers]}
        answeredCards={[...state.answeredCards]}
        activeBlockId={state.activeBlockId}
        ready
        reducedMotion
        trayKey="closed"
        onLocate={() => {}}
      />,
    );

    expect(host.querySelector('[data-testid="board-pagination"]')?.textContent).toContain("第 2 / 2 页");
    expect(host.textContent).toContain("第二页例题推导");
    expect(host.textContent).not.toContain("第一页核心公式");

    const prevBtn = host.querySelector<HTMLButtonElement>('button[aria-label="上一页"]');
    expect(prevBtn).not.toBeNull();
    act(() => {
      prevBtn!.click();
    });

    expect(host.querySelector('[data-testid="board-pagination"]')?.textContent).toContain("第 1 / 2 页");
    expect(host.textContent).toContain("第一页核心公式");
    expect(host.querySelector('[data-testid="jump-latest-page"]')).not.toBeNull();
  });

  it("reveals multi-step derivations line-by-line and instantaneously under reduced motion", () => {
    expect(nextRevealCount(1, 3, false)).toBe(2);
    expect(nextRevealCount(3, 3, false)).toBe(3);
    expect(nextRevealCount(1, 3, true)).toBe(3);

    vi.useFakeTimers();
    const block: Block = {
      id: "steps-1",
      type: "steps",
      content: "x + 1 = 3\nx = 3 - 1\nx = 2",
    };

    const host = mount(<BoardBlock block={block} progressiveSteps reducedMotion={false} />);
    expect(host.querySelectorAll("[data-board-line]")).toHaveLength(1);
    expect(host.querySelector('[data-board-line="steps-1.1"]')?.getAttribute("data-step-active")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelectorAll("[data-board-line]")).toHaveLength(2);
    expect(host.querySelector('[data-board-line="steps-1.2"]')?.getAttribute("data-step-active")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelectorAll("[data-board-line]")).toHaveLength(3);

    // Reduced motion reveals all lines immediately
    act(() => {
      root!.render(<BoardBlock block={block} progressiveSteps reducedMotion />);
    });
    expect(host.querySelectorAll("[data-board-line]")).toHaveLength(3);
  });

  it("renders underline, box, and color marks, dims stale marks, and points at specific lines", () => {
    expect(normalizeMarkStyle("underline")).toBe("underline");
    expect(normalizeMarkStyle("box")).toBe("box");
    expect(normalizeMarkStyle("highlight")).toBe("color");

    let state = advanceClassroom(
      initialClassroom,
      event(1, "board", {
        op: "add",
        id: "t1",
        type: "text",
        content: "第一行定义\n第二行条件\n第三行结论",
      }),
    );
    state = advanceClassroom(state, event(2, "mark", { target: "t1.1", style: "underline", color: "accent" }));
    state = advanceClassroom(state, event(3, "mark", { target: "t1.2", style: "box", color: "warn" }));
    state = advanceClassroom(state, event(4, "mark", { target: "t1.3", style: "color", color: "ok" }));
    state = advanceClassroom(state, event(5, "point", { target: "t1.2" }));

    expect(state.activePoint).toEqual({ blockId: "t1", line: 2, seq: 5 });
    expect(state.latestMarkSeq).toBe(4);

    const located: string[] = [];
    const host = mount(
      <BoardBlock
        block={state.board[0]!}
        latestMarkSeq={state.latestMarkSeq}
        locate={(target) => located.push(target)}
      />,
    );

    const line1 = host.querySelector('[data-board-line="t1.1"]');
    const line2 = host.querySelector('[data-board-line="t1.2"]');
    const line3 = host.querySelector('[data-board-line="t1.3"]');

    expect(line1?.getAttribute("data-mark-style")).toBe("underline");
    expect(line1?.getAttribute("data-mark-stale")).toBe("true");
    expect(line2?.getAttribute("data-mark-style")).toBe("box");
    expect(line2?.getAttribute("data-pointed")).toBe("true");
    expect(line3?.getAttribute("data-mark-style")).toBe("color");
    expect(line3?.getAttribute("data-mark-stale")).toBeNull();

    // Line-level "从这一行开始没跟上" works on text blocks
    const locateBtn = host.querySelector<HTMLButtonElement>('[data-testid="locate-t1-2"]');
    expect(locateBtn).not.toBeNull();
    act(() => {
      locateBtn!.click();
    });
    expect(located).toEqual(["t1.2"]);
  });
});

describe("U6 in-memory transcript ordering and recognizing placeholder", () => {
  it("interleaves teacher and student entries chronologically with source tags", () => {
    const teacher: SpokenEntry[] = [
      { id: "t1", role: "teacher", text: "先看极限定义", seq: 1, order: 1000 },
      { id: "t2", role: "teacher", text: "我换个例子讲", seq: 4, order: 4000 },
    ];
    const student: SpokenEntry[] = [
      { id: "s1", role: "student", text: "这里没听懂", badge: "quick", quickLabel: "没听懂", order: 1001 },
      { id: "s2", role: "student", text: "我明白了", badge: "voice", order: 4001 },
    ];

    const merged = mergeTranscriptEntries(teacher, student);
    expect(merged.map((m) => m.id)).toEqual(["t1", "s1", "t2", "s2"]);

    const host = mount(
      <TranscriptPanel
        entries={merged}
        teacherName="雪川"
        recording
        liveTranscript="正在说出回答"
        reducedMotion
      />,
    );

    const roles = Array.from(host.querySelectorAll("[data-transcript-role]")).map((el) =>
      el.getAttribute("data-transcript-role"),
    );
    expect(roles).toEqual(["teacher", "student", "teacher", "student"]);
    expect(host.querySelector('[data-testid="transcript-recognizing"]')?.textContent).toContain("正在说出回答");
  });
});

describe("U6 synthesized sound cues and microphone capture", () => {
  it("suppresses cues when speaking/recording, enforces unlock, and deduplicates within 40ms", () => {
    const starts: number[] = [];
    class FakeOsc {
      type = "sine";
      frequency = { setValueAtTime: vi.fn() };
      connect = vi.fn();
      start = vi.fn((t: number) => starts.push(t));
      stop = vi.fn();
    }
    class FakeGain {
      gain = {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      };
      connect = vi.fn();
    }
    class FakeAudioContext {
      state: AudioContextState = "running";
      currentTime = 0;
      destination = {};
      createOscillator = () => new FakeOsc();
      createGain = () => new FakeGain();
      resume = vi.fn(() => Promise.resolve());
      close = vi.fn(() => {
        this.state = "closed";
        return Promise.resolve();
      });
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    let suppressed = false;
    let clock = 1000;
    const player = new SoundCuePlayer({
      isSuppressed: () => suppressed,
      now: () => clock,
    });

    // Blocked before unlock()
    expect(player.play("connect")).toBe(false);

    player.unlock();
    expect(player.play("correct")).toBe(true);
    expect(starts.length).toBeGreaterThan(0);

    // Deduplicated within 40ms
    clock += SOUND_CUE_DEDUP_MS - 5;
    expect(player.play("correct")).toBe(false);

    // Allowed after 40ms
    clock += 10;
    expect(player.play("correct")).toBe(true);

    // Suppressed while teacher speaks or mic records
    suppressed = true;
    clock += 100;
    expect(player.play("your_turn")).toBe(false);

    // Disabled via prefs
    suppressed = false;
    player.setPrefs({ enabled: false });
    expect(player.play("lesson_end")).toBe(false);
  });

  it("classifies 3 microphone error causes and reuses warmed AudioContext across PTT presses", async () => {
    expect(classifyMicrophoneError(Object.assign(new Error("denied"), { name: "NotAllowedError" }))).toBe(
      "permission_denied",
    );
    expect(classifyMicrophoneError(Object.assign(new Error("missing"), { name: "NotFoundError" }))).toBe("not_found");
    expect(classifyMicrophoneError(new Error("busy"))).toBe("other");

    let contextCreations = 0;
    const addModule = vi.fn(() => Promise.resolve());
    const suspend = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());

    class WarmAudioContext {
      state: AudioContextState = "running";
      sampleRate = 48000;
      destination = {};
      audioWorklet = { addModule };
      constructor() {
        contextCreations += 1;
      }
      resume = vi.fn(() => {
        this.state = "running";
        return Promise.resolve();
      });
      suspend = suspend;
      close = close;
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }));
    }

    class FakeWorkletNode {
      port = { onmessage: null };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    const trackStop = vi.fn();
    vi.stubGlobal("AudioContext", WarmAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:worklet"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: trackStop }] })),
      },
    });

    const mic = new MicrophoneCapture();
    await mic.warmup();
    await mic.start(() => {});
    await mic.stop();
    await mic.start(() => {});
    await mic.stop();

    expect(contextCreations).toBe(1);
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(2);

    await mic.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders interactive plot sliders, syncs teacher board_param updates, and respects reduced motion", async () => {
    const plotContent = JSON.stringify({
      fn: ["a * x^2 + b"],
      x: [-5, 5],
      y: [-4, 4],
      params: [
        { name: "a", label: "开口系数 a", min: -3, max: 3, step: 0.5, default: 1 },
        { name: "b", label: "截距 b", min: -2, max: 2, step: 0.5, default: 0 },
      ],
      keyframes: [
        { label: "标准抛物线", values: { a: 1, b: 0 } },
        { label: "开口向下", values: { a: -2, b: 1 } },
      ],
    });

    let state = advanceClassroom(
      initialClassroom,
      event(1, "board", { op: "add", id: "plot-1", type: "plot", content: plotContent }),
    );
    state = advanceClassroom(
      state,
      event(2, "board_param", { target: "plot-1", name: "a", value: -1.5 }),
    );
    expect(state.board[0]?.paramValues).toEqual({ a: -1.5 });
    expect(state.avatar.pose).toBe("board_guiding");

    const host = mount(<BoardBlock block={state.board[0]!} reducedMotion={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(host.querySelector('[data-testid="plot-controls"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="plot-param-value-a"]')?.textContent).toContain("-1.5");
    expect(host.querySelector('[data-testid="plot-play-toggle"]')).not.toBeNull();

    const secondKeyframe = host.querySelector<HTMLButtonElement>('[data-testid="plot-keyframe-1"]');
    expect(secondKeyframe).not.toBeNull();
    act(() => {
      secondKeyframe!.click();
    });
    expect(host.querySelector('[data-testid="plot-param-value-a"]')?.textContent).toContain("-2");
    expect(host.querySelector('[data-testid="plot-param-value-b"]')?.textContent).toContain("1");

    const resetBtn = host.querySelector<HTMLButtonElement>('[data-testid="plot-reset"]');
    expect(resetBtn).not.toBeNull();
    act(() => {
      resetBtn!.click();
    });
    expect(host.querySelector('[data-testid="plot-param-value-a"]')?.textContent).toContain("1");
    expect(host.querySelector('[data-testid="plot-param-value-b"]')?.textContent).toContain("0");

    // Reduced motion hides auto-play toggle while keeping manual keyframes and sliders usable
    act(() => {
      root!.render(<BoardBlock block={state.board[0]!} reducedMotion />);
    });
    expect(host.querySelector('[data-testid="plot-play-toggle"]')).toBeNull();
    expect(host.querySelector('[data-testid="plot-param-slider-a"]')).not.toBeNull();
  });
});
