import { actionToClipSlot, ONE_SHOT_CLIPS, poseToClipSlot } from "./choreographer";
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
  private transitionSeq = 0;

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
    root.append(anchor, videoA, videoB);
    container.replaceChildren(root);

    this.root = root;
    this.players = [videoA, videoB];
    this.activeSlotIndex = 0;

    if (!resolveClipUrl(this.clips, "idle_breathe")) {
      this.emitStatus({
        state: "degraded",
        tier: "loop_pack",
        reason: "No playable video clips in loop pack.",
        fallbackTier: "static",
      });
      return;
    }

    if (!this.reducedMotion) {
      this.switchToClip("idle_breathe", false);
    }
    this.emitStatus({ state: "ready", tier: "loop_pack" });
  }

  async unmount(): Promise<void> {
    this.transitionSeq += 1;
    this.clearTimers();
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

  private switchToClip(desired: ClipSlot, oneShot: boolean): void {
    if (!this.players || !this.root) return;
    const resolved = resolveClipUrl(this.clips, desired);
    if (!resolved) return;

    this.clearOneShotTimer();
    if (resolved.url === this.currentUrl && !oneShot) {
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      return;
    }

    const seq = ++this.transitionSeq;
    const nextIndex: 0 | 1 = this.activeSlotIndex === 0 ? 1 : 0;
    const prevVideo = this.players[this.activeSlotIndex];
    const nextVideo = this.players[nextIndex];
    const shouldLoop = !oneShot;

    nextVideo.onended = null;
    nextVideo.onerror = () => {
      if (seq !== this.transitionSeq) return;
      if (desired !== "idle_breathe") {
        this.switchToClip("idle_breathe", false);
      } else {
        this.emitStatus({
          state: "degraded",
          tier: "loop_pack",
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
      nextVideo.style.zIndex = "3";
      prevVideo.style.zIndex = "2";
      nextVideo.style.opacity = "1";
      prevVideo.style.opacity = "0";
      this.activeSlotIndex = nextIndex;
      this.currentUrl = resolved.url;
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      const playResult = nextVideo.play?.();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => undefined);
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
    window.setTimeout(reveal, 120);
  }

  private clearOneShotTimer(): void {
    if (this.oneShotTimer !== null) {
      window.clearTimeout(this.oneShotTimer);
      this.oneShotTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearOneShotTimer();
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
