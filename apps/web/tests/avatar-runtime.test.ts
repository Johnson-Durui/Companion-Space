import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_CLIP_SLOTS,
  CLIP_ENTRY_BY_ID,
  CLIP_SLOTS,
  resolveStillForLocation,
} from "@companion-space/avatar-engine/catalog";
import {
  phaseToSituation,
  phaseToTutorPose,
  poseToClipSlot,
  quickActionToInstantAction,
  verdictToInstantAction,
} from "@companion-space/avatar-engine/choreographer";
import { LiveCostGuard } from "@companion-space/avatar-engine/cost-guard";
import { VideoDriverManager } from "@companion-space/avatar-engine/driver-manager";
import { LoopPackVideoDriver, resolveClipUrl } from "@companion-space/avatar-engine/loop-pack-driver";
import { StaticPortraitDriver } from "@companion-space/avatar-engine/static-driver";
import { tutorVideoCoordinator } from "@companion-space/avatar-engine/video-coordinator";
import { decodeTsvfFrame, encodeTsvaFrame, TSVF_MAGIC } from "@companion-space/avatar-engine/sidecar-driver";
import type { ClipSlot, VideoAvatarRuntimeConfig, VideoDriverStatusEvent } from "@companion-space/avatar-engine/types";

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

  it("keeps previous clip visible until next clip decodes first frame, discards stale commands, and prefetches clips on idle", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const createdVideos: Array<{
      src: string;
      readyState: number;
      style: Record<string, unknown>;
      listeners: Map<string, Set<() => void>>;
      emit: (event: string) => void;
    }> = [];

    const makeElement = (tag: string) => {
      const attrs = new Map<string, string>();
      const listeners = new Map<string, Set<() => void>>();
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
        readyState: 0,
        currentTime: 0,
        onended: null as (() => void) | null,
        onerror: null as (() => void) | null,
        listeners,
        emit(event: string) {
          for (const cb of [...(listeners.get(event) ?? [])]) {
            listeners.get(event)?.delete(cb);
            cb();
          }
        },
        append(...items: unknown[]) { this.children.push(...items); },
        replaceChildren(...items: unknown[]) { this.children = [...items]; },
        remove() {},
        getAttribute(name: string) { return name === "src" ? (this.src || null) : (attrs.get(name) ?? null); },
        setAttribute(name: string, value: string) { attrs.set(name, value); },
        removeAttribute(name: string) { if (name === "src") this.src = ""; attrs.delete(name); },
        addEventListener(name: string, cb: () => void) {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
        },
        removeEventListener(name: string, cb: () => void) {
          listeners.get(name)?.delete(cb);
        },
        load: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
      };
      if (tag === "video") createdVideos.push(el);
      return el;
    };

    vi.stubGlobal("document", { createElement: makeElement });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", fetchMock);

    const container = makeElement("div") as unknown as HTMLElement;
    const driver = new LoopPackVideoDriver();
    await driver.mount(container, {
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
        },
      },
    });

    // Simulate idle_breathe decoding its first frame -> video[1] becomes active & visible
    const idleVideo = createdVideos.find((v) => v.src === "/clips/idle.webm")!;
    idleVideo.readyState = 2;
    idleVideo.emit("loadeddata");
    expect(idleVideo.style.opacity).toBe("1");

    // Switch to lecturing while nextVideo is not yet decoded (readyState = 0)
    driver.setPose("lecturing", 2);
    const speakVideo = createdVideos.find((v) => v.src === "/clips/speak_a.webm")!;
    // Even after 250ms, old video stays visible until loadeddata fires (no premature 120ms swap)
    vi.advanceTimersByTime(250);
    expect(idleVideo.style.opacity).toBe("1");
    expect(speakVideo.style.opacity).toBe("0");

    // Stale generation command is ignored
    driver.setPose("listening_empathy", 1);
    expect(driver.getActiveClipSlot()).toBe("speak_explain_a");

    // Idle prefetch runs and fetches all unique clip URLs
    vi.advanceTimersByTime(300);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Once speakVideo decodes first frame, it swaps cleanly to opacity=1
    speakVideo.readyState = 2;
    speakVideo.emit("loadeddata");
    expect(speakVideo.style.opacity).toBe("1");
    expect(idleVideo.style.opacity).toBe("0");

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

  it("enforces I16 single active video playback via tutorVideoCoordinator", () => {
    const primary = { pause: vi.fn(), resume: vi.fn(), isVisible: () => true };
    const tile = { pause: vi.fn(), resume: vi.fn(), isVisible: () => true };

    tutorVideoCoordinator.claim(primary, { primary: true });
    expect(tutorVideoCoordinator.getActiveOwner()).toBe(primary);

    // Hovering a tile pauses the primary showcase immediately
    tutorVideoCoordinator.claim(tile);
    expect(primary.pause).toHaveBeenCalledTimes(1);
    expect(tutorVideoCoordinator.getActiveOwner()).toBe(tile);

    // Leaving the tile restores the primary showcase automatically
    tutorVideoCoordinator.release(tile);
    expect(primary.resume).toHaveBeenCalledTimes(1);
    expect(tutorVideoCoordinator.getActiveOwner()).toBe(primary);

    tutorVideoCoordinator.unregister(primary);
    expect(tutorVideoCoordinator.getActiveOwner()).toBeNull();
  });
});

describe("Tutor Media Extension Invariants (I17–I20, I23 driver)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setupDomHarness(defaultDuration = 5) {
    const videos: Array<{
      src: string;
      loop: boolean;
      duration: number;
      readyState: number;
      currentTime: number;
      style: Record<string, unknown>;
      onended: (() => void) | null;
      onerror: (() => void) | null;
      emit: (event: string) => void;
    }> = [];
    const surfaceRef: { current: { dataset: Record<string, string> } | null } = { current: null };

    const makeElement = (tag: string) => {
      const attrs = new Map<string, string>();
      const listeners = new Map<string, Set<() => void>>();
      const style: Record<string, unknown> = {
        setProperty(k: string, v: string) {
          style[k] = v;
        },
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
        duration: defaultDuration,
        currentTime: 0,
        onended: null as (() => void) | null,
        onerror: null as (() => void) | null,
        emit(event: string) {
          for (const cb of [...(listeners.get(event) ?? [])]) {
            listeners.get(event)?.delete(cb);
            cb();
          }
        },
        append(...items: unknown[]) {
          this.children.push(...items);
        },
        replaceChildren(...items: unknown[]) {
          this.children = [...items];
          surfaceRef.current = (items[0] as { dataset: Record<string, string> }) ?? null;
        },
        remove() {},
        getAttribute(name: string) {
          return name === "src" ? (this.src || null) : (attrs.get(name) ?? null);
        },
        setAttribute(name: string, value: string) {
          attrs.set(name, value);
        },
        removeAttribute(name: string) {
          if (name === "src") this.src = "";
          attrs.delete(name);
        },
        addEventListener(name: string, cb: () => void) {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
        },
        removeEventListener(name: string, cb: () => void) {
          listeners.get(name)?.delete(cb);
        },
        load: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
      };
      if (tag === "video") videos.push(el);
      return el;
    };

    vi.stubGlobal("document", { createElement: makeElement, hidden: false });
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
    return {
      container: makeElement("div") as unknown as HTMLElement,
      videos,
      getSurface: () => surfaceRef.current,
    };
  }

  it("I17: single-source catalog defines all active & reserved slots and resolves every clip", () => {
    expect(ACTIVE_CLIP_SLOTS.length).toBe(27);
    expect(CLIP_SLOTS.length).toBeGreaterThanOrEqual(27);
    const fullClips: Partial<Record<ClipSlot, string>> = {};
    for (const slot of CLIP_SLOTS) {
      expect(CLIP_ENTRY_BY_ID.has(slot)).toBe(true);
      fullClips[slot] = `/clips/${slot}.webm`;
    }
    for (const slot of CLIP_SLOTS) {
      expect(resolveClipUrl(fullClips, slot)).toEqual({ slot, url: `/clips/${slot}.webm` });
    }
    // Missing one-shot with no fallback returns null (never falls back to loop clip)
    expect(resolveClipUrl({ idle_breathe: "/a.webm" }, "greet_wave")).toBeNull();
    expect(resolveClipUrl({ idle_breathe: "/a.webm" }, "farewell_wave")).toBeNull();
    expect(resolveClipUrl({ idle_breathe: "/a.webm" }, "board_glance")).toBeNull();
  });

  it("I18: legacy 8-clip pack reproduces exact baseline clip sequence", async () => {
    vi.useFakeTimers();
    const { container, videos, getSurface } = setupDomHarness(3.5);
    const legacyClips: Partial<Record<ClipSlot, string>> = {
      idle_breathe: "/clips/idle_breathe.webm",
      listen_nod: "/clips/listen_nod.webm",
      think_chin: "/clips/think_chin.webm",
      speak_explain_a: "/clips/speak_explain_a.webm",
      speak_explain_b: "/clips/speak_explain_b.webm",
      board_point: "/clips/board_point.webm",
      react_praise: "/clips/react_praise.webm",
      react_comfort: "/clips/react_comfort.webm",
    };

    const driver = new LoopPackVideoDriver();
    await driver.mount(container, {
      characterId: "tutor-legacy",
      name: "Legacy",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      loopPack: { crossfadeMs: 180, clips: legacyClips },
    });

    const seen: string[] = [];
    const record = () => seen.push(getSurface()?.dataset.clip ?? "");
    record(); // mount -> idle_breathe

    driver.setSituation(phaseToSituation("preparing"), 0, 1);
    record(); // think_chin
    driver.setSituation(phaseToSituation("speaking"), 1, 2);
    record(); // speak_explain_a
    driver.setSituation(phaseToSituation("speaking"), 2, 2);
    record(); // speak_explain_b
    driver.setSituation(phaseToSituation("speaking"), 3, 2);
    record(); // speak_explain_a
    driver.setSituation(phaseToSituation("awaiting"), 3, 3);
    record(); // listen_nod
    driver.setSituation(phaseToSituation("awaiting", { quietCompanion: true }), 3, 3);
    record(); // idle_breathe
    driver.setSituation(phaseToSituation("judging"), 3, 4);
    record(); // listen_nod
    driver.triggerOneShot("praise", 5);
    record(); // react_praise
    const praiseVid = videos.find((v) => v.src === "/clips/react_praise.webm");
    praiseVid?.onended?.();
    driver.triggerOneShot("comfort", 6);
    record(); // react_comfort
    driver.setSituation(phaseToSituation("paused"), 6, 7);
    record(); // idle_breathe

    expect(seen).toEqual([
      "idle_breathe",
      "think_chin",
      "speak_explain_a",
      "speak_explain_b",
      "speak_explain_a",
      "listen_nod",
      "idle_breathe",
      "listen_nod",
      "react_praise",
      "react_comfort",
      "idle_breathe",
    ]);
    await driver.unmount();
  });

  it("I19: 5-second one-shot clip plays past 4.2s and returns before 5.4s", async () => {
    vi.useFakeTimers();
    const { container } = setupDomHarness(5.0);
    const driver = new LoopPackVideoDriver();
    await driver.mount(container, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      loopPack: {
        crossfadeMs: 180,
        clips: {
          idle_breathe: "/clips/idle.webm",
          greet_wave: "/clips/greet.webm",
          speak_calm: "/clips/speak_calm.webm",
        },
      },
    });

    driver.setSituation("idle", 0, 1);
    driver.triggerOneShot("greet", 1);
    expect(driver.getActiveClipSlot()).toBe("greet_wave");

    vi.advanceTimersByTime(4200);
    expect(driver.getActiveClipSlot()).toBe("greet_wave");

    vi.advanceTimersByTime(1250);
    expect(driver.getActiveClipSlot()).toBe("idle_breathe");
    await driver.unmount();
  });

  it("I19b: speaking starts 0.3s after praise and waits until min(settle_ms, +1.5s)", async () => {
    vi.useFakeTimers();
    const { container } = setupDomHarness(4.0);
    const driver = new LoopPackVideoDriver();
    await driver.mount(container, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      loopPack: {
        crossfadeMs: 180,
        clips: {
          idle_breathe: "/clips/idle.webm",
          speak_calm: "/clips/speak_calm.webm",
          react_praise: "/clips/react_praise.webm",
          react_clap: "/clips/react_clap.webm",
        },
        clipMeta: {
          react_praise: { settleMs: 1200, durationMs: 3200 },
          react_clap: { settleMs: 2600, durationMs: 3500 },
        },
      },
      random: () => 0,
    });

    // Case 1: settle_ms (1200ms) < 300ms + 1500ms (1800ms)
    driver.triggerOneShot("praise", 1);
    expect(driver.getActiveClipSlot()).toBe("react_praise");
    vi.advanceTimersByTime(300);
    driver.setSituation("speaking", 1, 1);
    vi.advanceTimersByTime(800); // t=1100ms < 1200ms
    expect(driver.getActiveClipSlot()).toBe("react_praise");
    vi.advanceTimersByTime(150); // t=1250ms >= 1200ms
    expect(driver.getActiveClipSlot()).toBe("speak_calm");

    // Case 2: settle_ms (2600ms) > 300ms + 1500ms (1800ms), capped at 1.5s after speech start
    driver.triggerOneShot("praise", 2);
    expect(driver.getActiveClipSlot()).toBe("react_clap"); // non-repeating praise group
    vi.advanceTimersByTime(300);
    driver.setSituation("speaking", 2, 2);
    vi.advanceTimersByTime(1400); // t=1700ms < 1800ms
    expect(driver.getActiveClipSlot()).toBe("react_clap");
    vi.advanceTimersByTime(150); // t=1850ms >= 1800ms
    expect(driver.getActiveClipSlot()).toBe("speak_calm");
    await driver.unmount();
  });

  it("I20: idle scheduler inserts idle_glance within 60s with full idle_breathe between inserts, and never inserts without variants", async () => {
    vi.useFakeTimers();
    const { container, videos } = setupDomHarness(6.0);

    // Pack WITH idle_glance
    const driver = new LoopPackVideoDriver();
    await driver.mount(container, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      loopPack: {
        crossfadeMs: 180,
        clips: {
          idle_breathe: "/clips/idle_breathe.webm",
          idle_glance: "/clips/idle_glance.webm",
        },
      },
      random: () => 0, // fixed 12s interval
    });

    driver.setSituation("idle", 0, 1);
    const seq: string[] = [driver.getActiveClipSlot() ?? ""];
    for (let step = 0; step < 10; step += 1) {
      vi.advanceTimersByTime(6000);
      const currentSlot = driver.getActiveClipSlot();
      const active = videos.find((v) => v.src.includes(currentSlot ?? "") && v.onended);
      active?.onended?.();
      seq.push(driver.getActiveClipSlot() ?? "");
    }
    expect(seq).toContain("idle_breathe");
    expect(seq).toContain("idle_glance");
    // Verify no two idle_glance clips appear back-to-back without idle_breathe in between
    for (let i = 1; i < seq.length; i += 1) {
      if (seq[i] === "idle_glance") {
        expect(seq[i - 1]).toBe("idle_breathe");
      }
    }
    await driver.unmount();

    // Pack WITHOUT idle_glance / idle_fidget -> loops natively without insertion
    const driverOnly = new LoopPackVideoDriver();
    await driverOnly.mount(container, {
      characterId: "tutor-min",
      name: "Min",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      loopPack: {
        crossfadeMs: 180,
        clips: { idle_breathe: "/clips/idle_breathe.webm" },
      },
    });
    driverOnly.setSituation("idle", 0, 1);
    const activeOnly = videos[videos.length - 1];
    expect(activeOnly.loop).toBe(true);
    expect(driverOnly.getActiveClipSlot()).toBe("idle_breathe");
    await driverOnly.unmount();
  });

  it("I23 (driver): static & reduced-motion modes swap expression stills and expose data-still", async () => {
    vi.useFakeTimers();
    const { container, getSurface } = setupDomHarness(5.0);
    const stills = {
      praise: "/stills/praise.webp",
      cheerful: "/stills/cheerful.webp",
      caring: "/stills/caring.webp",
      curious: "/stills/curious.webp",
      focused: "/stills/focused.webp",
      thinking: "/stills/thinking.webp",
      playful: "/stills/playful.webp",
    };

    const staticDriver = new StaticPortraitDriver();
    await staticDriver.mount(container, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "static",
      anchorImage: "/anchor.webp",
      loopPack: { crossfadeMs: 180, clips: {}, stills },
    });

    staticDriver.triggerOneShot("praise", 1);
    expect(getSurface()?.dataset.still).toBe("praise");

    staticDriver.triggerOneShot("comfort", 2);
    expect(getSurface()?.dataset.still).toBe("caring");

    staticDriver.setSituation("wait", 0, 3);
    vi.advanceTimersByTime(2700);
    expect(getSurface()?.dataset.still).toBe("curious");
    await staticDriver.unmount();

    // Reduced-motion loop_pack driver also switches stills and sets data-still
    const reducedDriver = new LoopPackVideoDriver();
    await reducedDriver.mount(container, {
      characterId: "tutor-chutang",
      name: "Chutang",
      aspectRatio: "9:16",
      preferredTier: "loop_pack",
      anchorImage: "/anchor.webp",
      reducedMotion: true,
      loopPack: {
        crossfadeMs: 180,
        clips: { idle_breathe: "/clips/idle.webm" },
        stills: { cheerful: "/stills/cheerful.webp", caring: "/stills/caring.webp" },
      },
    });
    // Without praise still, falls back to cheerful (§4.6)
    reducedDriver.triggerOneShot("praise", 1);
    expect(getSurface()?.dataset.still).toBe("cheerful");
    reducedDriver.triggerOneShot("comfort", 2);
    expect(getSurface()?.dataset.still).toBe("caring");
    await reducedDriver.unmount();

    // Off-classroom location still mapping table
    expect(resolveStillForLocation("today_greeting", stills, "/anchor.webp").still).toBe("cheerful");
    expect(resolveStillForLocation("unlock", stills, "/anchor.webp").still).toBe("focused");
    expect(resolveStillForLocation("not_found", stills, "/anchor.webp").still).toBe("curious");
    expect(resolveStillForLocation("recap", { cheerful: "/stills/cheerful.webp" }, "/anchor.webp").still).toBe("cheerful");
    expect(resolveStillForLocation("recap", {}, "/anchor.webp").still).toBe("anchor");
  });
});
