import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInitialChoreographerState,
  IDLE_COMPANION_MS,
  quickActionToInstantAction,
  reduceChoreographer,
  verdictToInstantAction,
} from "@companion-space/avatar-engine/choreographer";
import { LiveCostGuard } from "@companion-space/avatar-engine/cost-guard";
import { VideoDriverManager } from "@companion-space/avatar-engine/driver-manager";
import { LoopPackVideoDriver, resolveClipUrl } from "@companion-space/avatar-engine/loop-pack-driver";
import { decodeTsvfFrame, encodeTsvaFrame, TSVF_MAGIC } from "@companion-space/avatar-engine/sidecar-driver";
import type { VideoAvatarRuntimeConfig, VideoDriverStatusEvent } from "@companion-space/avatar-engine/types";

describe("AvatarChoreographer pure video state machine", () => {
  it("alternates speaking gesture clips, ignores stale generations, and resets on interrupt", () => {
    let state = createInitialChoreographerState();
    state = reduceChoreographer(state, { type: "lesson_open", gen: 1 });
    expect(state.pose).toBe("greeting");

    state = reduceChoreographer(state, { type: "speaking", gen: 2, seg: 2, emotion: "warm", stage: "teaching" });
    expect(state.pose).toBe("lecturing");
    expect(state.clip).toBe("speak_explain_a");

    state = reduceChoreographer(state, { type: "speaking", gen: 2, seg: 3, emotion: "focused", stage: "teaching" });
    expect(state.clip).toBe("speak_explain_b");

    // Stale generation must be ignored.
    const ignored = reduceChoreographer(state, { type: "board_point", gen: 1 });
    expect(ignored).toBe(state);

    state = reduceChoreographer(state, { type: "interrupt", gen: 2 });
    expect(state.pose).toBe("listening_empathy");
    expect(state.clip).toBe("listen_nod");
    expect(state.activeAction).toBeNull();
  });

  it("maps classroom quick actions and verdicts to instant reactions", () => {
    expect(quickActionToInstantAction("confused")).toBe("gentle_encourage");
    expect(quickActionToInstantAction("hint")).toBe("think_chin");
    expect(quickActionToInstantAction("show_answer")).toBe("board_point");
    expect(quickActionToInstantAction("locate:b1.2")).toBe("board_point");
    expect(verdictToInstantAction("correct")).toBe("praise_thumbs_up");
    expect(verdictToInstantAction("incorrect")).toBe("gentle_encourage");
  });

  it("enters quiet idle_companion after 15s silence and wakes immediately on learner activity", () => {
    let state = createInitialChoreographerState();
    state = reduceChoreographer(state, { type: "waiting", gen: 3, nowMs: 1_000 });
    expect(state.pose).toBe("listening_empathy");
    expect(state.quietCompanion).toBe(false);

    state = reduceChoreographer(state, { type: "tick", nowMs: 1_000 + IDLE_COMPANION_MS - 1 });
    expect(state.quietCompanion).toBe(false);

    state = reduceChoreographer(state, { type: "tick", nowMs: 1_000 + IDLE_COMPANION_MS });
    expect(state.pose).toBe("idle_companion");
    expect(state.clip).toBe("idle_breathe");
    expect(state.quietCompanion).toBe(true);

    state = reduceChoreographer(state, { type: "learner_activity", nowMs: 20_000 });
    expect(state.pose).toBe("listening_empathy");
    expect(state.quietCompanion).toBe(false);
  });
});

describe("LoopPackVideoDriver and fallback resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves missing clips deterministically through the fallback chain", () => {
    expect(resolveClipUrl({ idle_breathe: "/a.webm", speak_explain_a: "/b.webm" }, "speak_explain_b")).toEqual({
      slot: "speak_explain_a",
      url: "/b.webm",
    });
    expect(resolveClipUrl({ idle_breathe: "/a.webm" }, "react_comfort")).toEqual({
      slot: "idle_breathe",
      url: "/a.webm",
    });
    expect(resolveClipUrl({}, "idle_breathe")).toBeNull();
  });

  it("crossfades A/B videos, returns after one-shot reaction, and interrupts cleanly", async () => {
    vi.useFakeTimers();
    const createdVideos: Array<{
      src: string;
      onended: (() => void) | null;
    }> = [];

    const makeElement = (tag: string) => {
      const attrs = new Map<string, string>();
      const style: Record<string, unknown> = {
        setProperty(k: string, v: string) { style[k] = v; },
      };
      const el = {
        tagName: tag.toUpperCase(),
        className: "",
        dataset: {} as Record<string, string>,
        style,
        children: [] as unknown[],
        src: "",
        loop: false,
        muted: false,
        playsInline: false,
        preload: "",
        readyState: 4,
        currentTime: 0,
        onended: null as (() => void) | null,
        onerror: null as (() => void) | null,
        append(...items: unknown[]) { this.children.push(...items); },
        replaceChildren(...items: unknown[]) { this.children = [...items]; },
        remove() {},
        getAttribute(name: string) { return name === "src" ? (this.src || null) : (attrs.get(name) ?? null); },
        setAttribute(name: string, value: string) { attrs.set(name, value); },
        removeAttribute(name: string) { if (name === "src") this.src = ""; attrs.delete(name); },
        addEventListener() {},
        removeEventListener() {},
        load: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
      };
      if (tag === "video") createdVideos.push(el);
      return el;
    };

    vi.stubGlobal("document", { createElement: makeElement });
    vi.stubGlobal("window", { setTimeout, clearTimeout });

    const container = makeElement("div") as unknown as HTMLElement;
    const config: VideoAvatarRuntimeConfig = {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/static/avatars/portraits/chutang.webp",
      loopPack: {
        crossfadeMs: 180,
        clips: {
          idle_breathe: "/clips/idle.webm",
          listen_nod: "/clips/listen.webm",
          speak_explain_a: "/clips/speak_a.webm",
          react_praise: "/clips/praise.webm",
        },
      },
    };

    const driver = new LoopPackVideoDriver();
    await driver.mount(container, config);
    expect(createdVideos).toHaveLength(2);
    expect(driver.getActiveClipSlot()).toBe("idle_breathe");

    driver.setPose("lecturing", 1);
    expect(driver.getActiveClipSlot()).toBe("speak_explain_a");

    driver.triggerInstantAction("praise_thumbs_up", 1);
    expect(driver.getActiveClipSlot()).toBe("react_praise");

    // Simulate one-shot clip ended -> smoothly returns to lecturing clip.
    const activeVideo = createdVideos.find((v) => v.src === "/clips/praise.webm");
    activeVideo?.onended?.();
    expect(driver.getActiveClipSlot()).toBe("speak_explain_a");

    // Interrupt immediately moves to listen_nod.
    driver.interrupt(1);
    expect(driver.getActiveClipSlot()).toBe("listen_nod");
    await driver.unmount();
  });
});

describe("LiveCostGuard and Sidecar Protocol + Fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("suspends on 30s silence, wakes on activity, and trips on budget limit", () => {
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const onBudgetExceeded = vi.fn();
    const guard = new LiveCostGuard(
      { idleSuspendSec: 30, maxSessionMinutes: 10, maxSessionCostCny: 20, costPerMinuteCny: 3 },
      { onSuspend, onResume, onBudgetExceeded },
    );

    guard.tick(15, true);
    expect(onSuspend).not.toHaveBeenCalled();
    guard.tick(15, true);
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(guard.snapshot.suspended).toBe(true);

    // While suspended, activeSec does not increase.
    guard.tick(60, true);
    expect(guard.snapshot.activeSec).toBe(30);

    guard.recordActivity();
    expect(onResume).toHaveBeenCalledOnce();
    expect(guard.snapshot.suspended).toBe(false);

    // Push past 10 minutes cap.
    guard.tick(600, false);
    expect(onBudgetExceeded).toHaveBeenCalledOnce();
  });

  it("encodes TSVA audio frames and decodes TSVF video frames accurately", () => {
    const pcm = new Int16Array([1000, -1000, 250]).buffer;
    const encoded = encodeTsvaFrame({ gen: 7, seg: 3, pcm16: pcm, sampleRate: 24000, last: true });
    const view = new DataView(encoded);
    expect(String.fromCharCode(...new Uint8Array(encoded, 0, 4))).toBe("TSVA");
    expect(view.getUint32(4, false)).toBe(7);
    expect(view.getUint32(8, false)).toBe(3);
    expect(view.getUint16(12, false)).toBe(1);
    expect(view.getUint16(14, false)).toBe(24000);

    const tsvf = new ArrayBuffer(20);
    new Uint8Array(tsvf).set(TSVF_MAGIC, 0);
    new Uint8Array(tsvf).set([1, 2, 3, 4], 16);
    const fview = new DataView(tsvf);
    fview.setUint32(4, 9, false);
    fview.setUint32(8, 1234, false);
    fview.setUint16(12, 1, false);
    const decoded = decodeTsvfFrame(tsvf);
    expect(decoded).not.toBeNull();
    expect(decoded?.gen).toBe(9);
    expect(decoded?.tsMs).toBe(1234);
    expect(decoded?.mimeType).toBe("image/webp");
    expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("falls back automatically from local_sidecar to static when sidecar connection fails", async () => {
    const makeEl = () => ({
      className: "",
      dataset: {} as Record<string, string>,
      style: { setProperty() {} } as Record<string, unknown>,
      append() {},
      replaceChildren() {},
      remove() {},
      setAttribute() {},
    });
    vi.stubGlobal("document", { createElement: makeEl });
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });

    const events: VideoDriverStatusEvent[] = [];
    const manager = new VideoDriverManager({
      sidecarConnector: {
        openSession: async () => {
          throw new Error("Connection refused");
        },
      },
      onStatusChange: (evt) => events.push(evt),
    });

    await manager.mount(makeEl() as unknown as HTMLElement, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "local_sidecar",
      anchorImage: "/static/avatars/portraits/chutang.webp",
      loopPack: { crossfadeMs: 180, clips: {} },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((e) => e.state === "degraded" && e.fallbackTier === "static")).toBe(true);
    expect(manager.currentTier).toBe("static");
    await manager.unmount();
  });
});
