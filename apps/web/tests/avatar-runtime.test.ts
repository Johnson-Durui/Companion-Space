import { afterEach, describe, expect, it, vi } from "vitest";
import {
  phaseToTutorPose,
  poseToClipSlot,
  quickActionToInstantAction,
  verdictToInstantAction,
} from "@companion-space/avatar-engine/choreographer";
import { LiveCostGuard } from "@companion-space/avatar-engine/cost-guard";
import { VideoDriverManager } from "@companion-space/avatar-engine/driver-manager";
import { LoopPackVideoDriver, resolveClipUrl } from "@companion-space/avatar-engine/loop-pack-driver";
import { decodeTsvfFrame, encodeTsvaFrame, TSVF_MAGIC } from "@companion-space/avatar-engine/sidecar-driver";
import type { VideoAvatarRuntimeConfig, VideoDriverStatusEvent } from "@companion-space/avatar-engine/types";

describe("AvatarChoreographer canonical phase-to-pose and action mapping", () => {
  it("maps explicit phases to poses and thinking/buffering never map to speaking clips", () => {
    expect(phaseToTutorPose("lobby")).toBe("idle_companion");
    expect(phaseToTutorPose("preparing")).toBe("thinking");
    expect(phaseToTutorPose("thinking")).toBe("thinking");
    expect(phaseToTutorPose("buffering")).toBe("thinking");
    expect(poseToClipSlot("thinking", 0)).toBe("think_chin");
    expect(poseToClipSlot("thinking", 1)).toBe("think_chin");

    expect(phaseToTutorPose("speaking", { isOpeningGreeting: true })).toBe("greeting");
    expect(phaseToTutorPose("speaking")).toBe("lecturing");
    expect(phaseToTutorPose("speaking", { boardGuiding: true })).toBe("board_guiding");
    expect(phaseToTutorPose("listening")).toBe("listening_empathy");
    expect(phaseToTutorPose("judging")).toBe("listening_empathy");
    expect(phaseToTutorPose("awaiting", { quietCompanion: false })).toBe("listening_empathy");
    expect(phaseToTutorPose("awaiting", { quietCompanion: true })).toBe("idle_companion");
    expect(phaseToTutorPose("paused")).toBe("idle_companion");
  });

  it("maps classroom quick actions and verdicts to instant reactions", () => {
    expect(quickActionToInstantAction("confused")).toBe("gentle_encourage");
    expect(quickActionToInstantAction("hint")).toBe("think_chin");
    expect(quickActionToInstantAction("show_answer")).toBe("board_point");
    expect(quickActionToInstantAction("locate:b1.2")).toBe("board_point");
    expect(verdictToInstantAction("correct")).toBe("praise_thumbs_up");
    expect(verdictToInstantAction("incorrect")).toBe("gentle_encourage");
    expect(verdictToInstantAction("partial")).toBe("gentle_encourage");
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

  it("keeps each instant action clip when classroom follows with feedback_reaction or board_guiding pose", async () => {
    vi.useFakeTimers();
    const surfaceRef: { current: { dataset: Record<string, string> } | null } = { current: null };
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
        replaceChildren(...items: unknown[]) {
          this.children = [...items];
          surfaceRef.current = (items[0] as { dataset: Record<string, string> }) ?? null;
        },
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
          think_chin: "/clips/think.webm",
          speak_explain_a: "/clips/speak_a.webm",
          speak_explain_b: "/clips/speak_b.webm",
          board_point: "/clips/point.webm",
          react_praise: "/clips/praise.webm",
          react_comfort: "/clips/comfort.webm",
        },
      },
    };

    const driver = new LoopPackVideoDriver();
    await driver.mount(container, config);

    const cases = [
      { action: "gentle_encourage" as const, pose: "feedback_reaction" as const, expectedClip: "react_comfort" },
      { action: "think_chin" as const, pose: "feedback_reaction" as const, expectedClip: "think_chin" },
      { action: "praise_thumbs_up" as const, pose: "feedback_reaction" as const, expectedClip: "react_praise" },
      { action: "praise_clap" as const, pose: "feedback_reaction" as const, expectedClip: "react_praise" },
      { action: "empathy_nod" as const, pose: "feedback_reaction" as const, expectedClip: "listen_nod" },
      { action: "board_point" as const, pose: "board_guiding" as const, expectedClip: "board_point" },
    ];

    for (const [index, entry] of cases.entries()) {
      const gen = index + 1;
      driver.triggerInstantAction(entry.action, gen);
      driver.setPose(entry.pose, gen);
      expect(driver.getActiveClipSlot()).toBe(entry.expectedClip);
      expect(surfaceRef.current?.dataset.clip).toBe(entry.expectedClip);
    }
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
    expect(
      events.some(
        (e) => e.state === "degraded" && e.fallbackTier === "static" && e.code === "sidecar_unavailable",
      ),
    ).toBe(true);
    expect(manager.currentTier).toBe("static");
    await manager.unmount();
  });
});
