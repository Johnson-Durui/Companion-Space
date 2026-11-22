import { actionToClipSlot, ONE_SHOT_CLIPS, poseToClipSlot } from "./choreographer";
import { tutorVideoCoordinator, type VideoPlaybackOwner } from "./video-coordinator";
import type {
  ClipSlot,
  InstantAction,
  ITutorVideoDriver,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoDriverCapabilities,
  VideoDriverStatusEvent,
} from "./types";

const FALLBACK_CHAIN: Record<ClipSlot, readonly ClipSlot[]> = {
  idle_breathe: ["idle_breathe", "listen_nod", "speak_explain_a"],
  listen_nod: ["listen_nod", "idle_breathe", "speak_explain_a"],
  think_chin: ["think_chin", "idle_breathe", "listen_nod"],
  speak_explain_a: ["speak_explain_a", "speak_explain_b", "idle_breathe"],
  speak_explain_b: ["speak_explain_b", "speak_explain_a", "idle_breathe"],
  board_point: ["board_point", "speak_explain_a", "idle_breathe"],
  react_praise: ["react_praise", "speak_explain_a", "idle_breathe"],
  react_comfort: ["react_comfort", "listen_nod", "idle_breathe"],
};

const ALL_ACTIONS: readonly InstantAction[] = [
  "greet",
  "empathy_nod",
  "think_chin",
  "praise_thumbs_up",
  "praise_clap",
  "gentle_encourage",
  "board_point",
  "farewell",
];

/** Maximum time to wait for a video frame decode before falling back to showing the clip anyway. */
const DECODE_SAFETY_TIMEOUT_MS = 3000;

export function resolveClipUrl(
  clips: Partial<Record<ClipSlot, string>>,
  desired: ClipSlot,
): { slot: ClipSlot; url: string } | null {
  for (const candidate of FALLBACK_CHAIN[desired]) {
    const url = clips[candidate];
    if (url) return { slot: candidate, url };
  }
  return null;
}

export class LoopPackVideoDriver implements ITutorVideoDriver {
  readonly id = "loop-pack-video";
  private root: HTMLDivElement | null = null;
  private players: [HTMLVideoElement, HTMLVideoElement] | null = null;
  private activeSlotIndex: 0 | 1 = 0;
  private currentUrl = "";
  private currentSlot: ClipSlot | null = null;
  private basePose: TutorPose = "idle_companion";
  private lectureVariant: 0 | 1 = 0;
  private currentGen = 0;
  private crossfadeMs = 180;
  private reducedMotion = false;
  private clips: Partial<Record<ClipSlot, string>> = {};
  private listeners = new Set<(event: VideoDriverStatusEvent) => void>();
  private fadeTimer: number | null = null;
  private oneShotTimer: number | null = null;
  private revealTimer: number | null = null;
  private prefetchTimer: number | null = null;
  private prefetchIdleId: number | null = null;
  private prefetchControllers: AbortController[] = [];
  private prefetchedUrls = new Set<string>();
  private transitionSeq = 0;
  private visible = true;
  private observer: IntersectionObserver | null = null;
  private readonly playbackOwner: VideoPlaybackOwner = {
    pause: () => this.pausePlayers(),
    resume: () => this.resumeActivePlayer(),
    isVisible: () => this.visible && !this.reducedMotion && Boolean(this.root),
  };

  getCapabilities(): VideoDriverCapabilities {
    return {
      tier: "loop_pack",
      lipSyncQuality: "ambient",
      supportsInstantActions: ALL_ACTIONS,
      supportsCustomActionPrompt: false,
      hasMeteredCost: false,
    };
  }

  async mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void> {
    await this.unmount();
    this.clips = { ...config.loopPack.clips };
    this.crossfadeMs = config.reducedMotion ? 0 : Math.max(0, Math.min(600, config.loopPack.crossfadeMs));
    this.reducedMotion = Boolean(config.reducedMotion);
    this.currentUrl = "";
    this.currentSlot = null;

    const root = document.createElement("div");
    root.className = "tvb-surface tvb-loop";
    root.dataset.tier = "loop_pack";
    root.dataset.pose = this.basePose;
    root.dataset.emotion = "neutral";
    root.style.setProperty("--speech-level", "0");
    root.style.setProperty("--tvb-fade-ms", `${this.crossfadeMs}ms`);

    const anchor = document.createElement("img");
    anchor.className = "tvb-anchor";
    anchor.src = config.anchorImage;
    anchor.alt = config.name;
    anchor.decoding = "async";

    const videoA = this.createVideoElement();
    const videoB = this.createVideoElement();

    const halo = document.createElement("span");
    halo.className = "tvb-halo";
    halo.setAttribute("aria-hidden", "true");

    root.append(anchor, videoA, videoB, halo);
    container.replaceChildren(root);

    this.root = root;
    this.players = [videoA, videoB];
    this.activeSlotIndex = 0;
    this.visible = true;
    this.attachVisibilityObserver(root);

    if (!resolveClipUrl(this.clips, "idle_breathe")) {
      this.emitStatus({
        state: "degraded",
        tier: "loop_pack",
        code: "loop_pack_empty",
        reason: "No playable video clips in loop pack.",
        fallbackTier: "static",
      });
      return;
    }

    if (!this.reducedMotion) {
      this.switchToClip("idle_breathe", false);
      this.scheduleIdlePrefetch();
    }
    this.emitStatus({ state: "ready", tier: "loop_pack" });
  }

  async unmount(): Promise<void> {
    this.transitionSeq += 1;
    this.clearTimers();
    this.cancelPrefetch();
    this.observer?.disconnect();
    this.observer = null;
    this.visible = false;
    tutorVideoCoordinator.unregister(this.playbackOwner);
    if (this.players) {
      for (const video of this.players) {
        video.onended = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      this.players = null;
    }
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
  }

  pushSpeechLevel(level: number): void {
    if (!this.root) return;
    const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    this.root.style.setProperty("--speech-level", clamped.toFixed(3));
  }

  setPose(pose: TutorPose, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (pose === "lecturing" && this.basePose === "lecturing") {
      this.lectureVariant = this.lectureVariant === 0 ? 1 : 0;
    }
    this.basePose = pose;
    if (this.root) this.root.dataset.pose = pose;
    if (this.reducedMotion) return;
    if (pose === "feedback_reaction") return;
    const target = poseToClipSlot(pose, this.lectureVariant);
    if (target === this.currentSlot && ONE_SHOT_CLIPS.has(target)) return;
    this.switchToClip(target, ONE_SHOT_CLIPS.has(target));
  }

  setMood(emotion: TutorEmotion, _intensity: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.emotion = emotion;
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.action = action;
    if (this.reducedMotion) return;
    const slot = actionToClipSlot(action);
    this.switchToClip(slot, ONE_SHOT_CLIPS.has(slot));
  }

  interrupt(gen: number): void {
    this.currentGen = Math.max(this.currentGen, gen);
    this.clearOneShotTimer();
    this.basePose = "listening_empathy";
    if (this.root) {
      delete this.root.dataset.action;
      this.root.dataset.pose = "listening_empathy";
      this.root.style.setProperty("--speech-level", "0");
    }
    if (!this.reducedMotion) {
      this.switchToClip("listen_nod", false);
    }
  }

  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getActiveClipSlot(): ClipSlot | null {
    return this.currentSlot;
  }

  private createVideoElement(): HTMLVideoElement {
    const video = document.createElement("video");
    video.className = "tvb-video";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("aria-hidden", "true");
    video.style.opacity = "0";
    return video;
  }

  private scheduleIdlePrefetch(): void {
    if (typeof fetch !== "function" || typeof AbortController === "undefined") return;
    const urls = Array.from(
      new Set(
        Object.values(this.clips).filter(
          (url): url is string => typeof url === "string" && Boolean(url) && !this.prefetchedUrls.has(url),
        ),
      ),
    );
    if (!urls.length) return;

    const run = () => {
      this.prefetchTimer = null;
      this.prefetchIdleId = null;
      if (!this.root) return;
      for (const url of urls) {
        if (this.prefetchedUrls.has(url)) continue;
        this.prefetchedUrls.add(url);
        const controller = new AbortController();
        this.prefetchControllers.push(controller);
        void fetch(url, { signal: controller.signal, credentials: "same-origin" }).catch(() => {
          this.prefetchedUrls.delete(url);
        });
      }
    };

    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") {
      this.prefetchIdleId = idle(run, { timeout: 1500 });
    } else {
      this.prefetchTimer = window.setTimeout(run, 400);
    }
  }

  private cancelPrefetch(): void {
    if (this.prefetchTimer !== null) {
      window.clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    if (this.prefetchIdleId !== null) {
      const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (typeof cancelIdle === "function") cancelIdle(this.prefetchIdleId);
      this.prefetchIdleId = null;
    }
    for (const controller of this.prefetchControllers) {
      controller.abort();
    }
    this.prefetchControllers = [];
  }

  private switchToClip(desired: ClipSlot, oneShot: boolean): void {
    if (!this.players || !this.root) return;
    const resolved = resolveClipUrl(this.clips, desired);
    if (!resolved) return;

    this.clearOneShotTimer();
    this.clearRevealTimer();
    if (resolved.url === this.currentUrl && !oneShot) {
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      return;
    }

    const seq = ++this.transitionSeq;
    this.currentSlot = resolved.slot;
    this.root.dataset.clip = resolved.slot;
    const nextIndex: 0 | 1 = this.activeSlotIndex === 0 ? 1 : 0;
    const prevVideo = this.players[this.activeSlotIndex];
    const nextVideo = this.players[nextIndex];
    const shouldLoop = !oneShot;

    nextVideo.onended = null;
    nextVideo.onerror = () => {
      if (seq !== this.transitionSeq) return;
      this.clearRevealTimer();
      if (desired !== "idle_breathe") {
        this.switchToClip("idle_breathe", false);
      } else {
        this.emitStatus({
          state: "degraded",
          tier: "loop_pack",
          code: "loop_pack_playback_failed",
          reason: "Video clip playback failed.",
          fallbackTier: "static",
        });
      }
    };

    nextVideo.loop = shouldLoop;
    if (nextVideo.getAttribute("src") !== resolved.url) {
      nextVideo.src = resolved.url;
      nextVideo.load();
    } else {
      try {
        nextVideo.currentTime = 0;
      } catch {
        // Ignore seek errors before metadata loads.
      }
    }

    let revealed = false;
    const reveal = () => {
      if (revealed || seq !== this.transitionSeq || !this.players || !this.root) return;
      revealed = true;
      this.clearRevealTimer();
      nextVideo.style.zIndex = "3";
      prevVideo.style.zIndex = "2";
      nextVideo.style.opacity = "1";
      prevVideo.style.opacity = "0";
      this.activeSlotIndex = nextIndex;
      this.currentUrl = resolved.url;
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      if (this.visible && (typeof document === "undefined" || !document.hidden)) {
        tutorVideoCoordinator.claim(this.playbackOwner, { primary: true });
        const playResult = nextVideo.play?.();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch(() => undefined);
        }
      }

      if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
      this.fadeTimer = window.setTimeout(() => {
        if (seq !== this.transitionSeq) return;
        prevVideo.pause();
        try {
          prevVideo.currentTime = 0;
        } catch {
          // Ignore reset errors on unloaded buffers.
        }
        this.fadeTimer = null;
      }, this.crossfadeMs + 20);

      if (oneShot) {
        const returnToBase = () => {
          if (seq !== this.transitionSeq) return;
          this.clearOneShotTimer();
          if (this.root) delete this.root.dataset.action;
          const baseSlot = poseToClipSlot(
            this.basePose === "board_guiding" || this.basePose === "feedback_reaction"
              ? "idle_companion"
              : this.basePose,
            this.lectureVariant,
          );
          this.switchToClip(baseSlot, false);
        };
        nextVideo.onended = returnToBase;
        this.oneShotTimer = window.setTimeout(returnToBase, 4000);
      }
    };

    // Decode-before-swap: only reveal immediately if first frame is already decoded (readyState >= 2).
    // Otherwise keep prevVideo playing visibly until loadeddata/canplay fires (no flash to static anchor).
    if (nextVideo.readyState >= 2) {
      reveal();
      return;
    }
    const onReady = () => {
      nextVideo.removeEventListener("loadeddata", onReady);
      nextVideo.removeEventListener("canplay", onReady);
      reveal();
    };
    nextVideo.addEventListener("loadeddata", onReady, { once: true });
    nextVideo.addEventListener("canplay", onReady, { once: true });
    this.revealTimer = window.setTimeout(() => {
      nextVideo.removeEventListener("loadeddata", onReady);
      nextVideo.removeEventListener("canplay", onReady);
      reveal();
    }, DECODE_SAFETY_TIMEOUT_MS);
  }

  private clearRevealTimer(): void {
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  private clearOneShotTimer(): void {
    if (this.oneShotTimer !== null) {
      window.clearTimeout(this.oneShotTimer);
      this.oneShotTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearOneShotTimer();
    this.clearRevealTimer();
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private attachVisibilityObserver(target: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextVisible = entry.isIntersecting;
        if (nextVisible === this.visible) return;
        this.visible = nextVisible;
        if (!nextVisible) {
          this.pausePlayers();
          tutorVideoCoordinator.release(this.playbackOwner);
        } else if (!this.reducedMotion) {
          tutorVideoCoordinator.claim(this.playbackOwner, { primary: true });
          this.resumeActivePlayer();
        }
      },
      { threshold: 0.05 },
    );
    this.observer.observe(target);
  }

  private pausePlayers(): void {
    if (!this.players) return;
    for (const video of this.players) {
      video.pause?.();
    }
  }

  private resumeActivePlayer(): void {
    if (!this.players || !this.visible || this.reducedMotion) return;
    const active = this.players[this.activeSlotIndex];
    if (!active || !active.getAttribute("src")) return;
    const playResult = active.play?.();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => undefined);
    }
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
