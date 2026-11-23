import {
  legacyPoseActionToStill,
  oneShotToInstantAction,
  resolveDesiredStill,
  resolveStillUrl,
  situationToTutorPose,
} from "./choreographer";
import type {
  InstantAction,
  ITutorVideoDriver,
  OneShotKind,
  Situation,
  StillSlot,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoDriverCapabilities,
  VideoDriverStatusEvent,
} from "./types";

const STATIC_ACTIONS: readonly InstantAction[] = [
  "greet",
  "empathy_nod",
  "think_chin",
  "praise_thumbs_up",
  "praise_clap",
  "gentle_encourage",
  "board_point",
  "farewell",
];

export class StaticPortraitDriver implements ITutorVideoDriver {
  readonly id = "static-portrait";
  private root: HTMLDivElement | null = null;
  private stillImgs: [HTMLImageElement, HTMLImageElement] | null = null;
  private activeImgIndex: 0 | 1 = 0;
  private anchorImage = "";
  private stills: Partial<Record<StillSlot, string>> = {};
  private currentStill: StillSlot | "anchor" = "anchor";
  private currentSituation: Situation = "idle";
  private activeOneShot: OneShotKind | null = null;
  private currentPose: TutorPose = "idle_companion";
  private activeLegacyAction: InstantAction | null = null;
  private useSituationMode = false;
  private listeners = new Set<(event: VideoDriverStatusEvent) => void>();
  private currentGen = 0;
  private actionTimer: number | null = null;

  getCapabilities(): VideoDriverCapabilities {
    return {
      tier: "static",
      lipSyncQuality: "ambient",
      supportsInstantActions: STATIC_ACTIONS,
      supportsCustomActionPrompt: false,
      hasMeteredCost: false,
    };
  }

  async mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void> {
    await this.unmount();
    this.anchorImage = config.anchorImage;
    this.stills = { ...(config.loopPack?.stills ?? {}) };
    this.currentStill = "anchor";
    this.currentSituation = "idle";
    this.activeOneShot = null;
    this.currentPose = "idle_companion";
    this.activeLegacyAction = null;
    this.useSituationMode = false;
    this.activeImgIndex = 0;

    const root = document.createElement("div");
    root.className = "tvb-surface tvb-static";
    root.dataset.tier = "static";
    root.dataset.pose = "idle_companion";
    root.dataset.emotion = "neutral";
    root.dataset.still = "anchor";
    root.style.setProperty("--speech-level", "0");

    const halo = document.createElement("span");
    halo.className = "tvb-halo";
    halo.setAttribute("aria-hidden", "true");

    const imgA = document.createElement("img");
    imgA.className = "tvb-anchor tvb-still-layer";
    imgA.src = config.anchorImage;
    imgA.alt = config.name;
    imgA.decoding = "async";
    imgA.style.opacity = "1";
    imgA.style.zIndex = "2";

    const imgB = document.createElement("img");
    imgB.className = "tvb-anchor tvb-still-layer";
    imgB.src = config.anchorImage;
    imgB.alt = "";
    imgB.setAttribute("aria-hidden", "true");
    imgB.decoding = "async";
    imgB.style.opacity = "0";
    imgB.style.zIndex = "1";

    root.append(halo, imgA, imgB);
    container.replaceChildren(root);
    this.root = root;
    this.stillImgs = [imgA, imgB];
    this.emitStatus({ state: "ready", tier: "static" });
  }

  async unmount(): Promise<void> {
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.stillImgs = null;
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
    this.currentPose = pose;
    if (this.root) {
      this.root.dataset.pose = pose;
    }
    if (!this.useSituationMode) {
      const desired = legacyPoseActionToStill(pose, this.activeLegacyAction);
      this.applyStill(desired);
    }
  }

  setMood(emotion: TutorEmotion, _intensity: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) {
      this.root.dataset.emotion = emotion;
    }
  }

  setSituation(situation: Situation, _sentenceSeq: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    this.useSituationMode = true;
    this.currentSituation = situation;
    const legacyPose = situationToTutorPose(situation);
    this.currentPose = legacyPose;
    if (this.root) {
      this.root.dataset.situation = situation;
      this.root.dataset.pose = legacyPose;
    }
    if (situation === "paused" || situation === "frozen" || situation === "loading") {
      this.activeOneShot = null;
    }
    this.applyStill(resolveDesiredStill(this.currentSituation, this.activeOneShot));
  }

  triggerOneShot(kind: OneShotKind, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    this.useSituationMode = true;
    this.activeOneShot = kind;
    const legacy = oneShotToInstantAction(kind);
    if (this.root && legacy) {
      this.root.dataset.action = legacy;
    }
    this.applyStill(resolveDesiredStill(this.currentSituation, kind));
    if (this.actionTimer !== null) window.clearTimeout(this.actionTimer);
    this.actionTimer = window.setTimeout(() => {
      if (this.activeOneShot === kind) {
        this.activeOneShot = null;
        if (this.root && legacy && this.root.dataset.action === legacy) {
          delete this.root.dataset.action;
        }
        this.applyStill(resolveDesiredStill(this.currentSituation, null));
      }
      this.actionTimer = null;
    }, 2600);
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (!this.root) return;
    this.activeLegacyAction = action;
    this.root.dataset.action = action;
    if (!this.useSituationMode) {
      this.applyStill(legacyPoseActionToStill(this.currentPose, action));
    }
    if (this.actionTimer !== null) window.clearTimeout(this.actionTimer);
    this.actionTimer = window.setTimeout(() => {
      if (this.root && this.root.dataset.action === action) {
        delete this.root.dataset.action;
      }
      if (this.activeLegacyAction === action) {
        this.activeLegacyAction = null;
        if (!this.useSituationMode) {
          this.applyStill(legacyPoseActionToStill(this.currentPose, null));
        }
      }
      this.actionTimer = null;
    }, 1800);
  }

  showStill(still: StillSlot | "anchor"): void {
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.activeOneShot = null;
    this.applyStill(still);
  }

  interrupt(gen: number): void {
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.activeOneShot = null;
    this.activeLegacyAction = null;
    this.currentPose = "listening_empathy";
    if (this.root) {
      delete this.root.dataset.action;
      this.root.dataset.pose = "listening_empathy";
      this.root.style.setProperty("--speech-level", "0");
    }
    this.applyStill("anchor");
  }

  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getActiveStill(): StillSlot | "anchor" {
    return this.currentStill;
  }

  private applyStill(desired: StillSlot | "anchor"): void {
    if (!this.root || !this.stillImgs) return;
    const resolved = resolveStillUrl(this.stills, this.anchorImage, desired);
    this.root.dataset.still = resolved.still;
    if (resolved.still === this.currentStill) return;
    this.currentStill = resolved.still;

    const prevIndex = this.activeImgIndex;
    const nextIndex: 0 | 1 = prevIndex === 0 ? 1 : 0;
    const prevImg = this.stillImgs[prevIndex];
    const nextImg = this.stillImgs[nextIndex];
    if (nextImg.getAttribute("src") !== resolved.url) {
      nextImg.src = resolved.url;
    }
    nextImg.style.zIndex = "2";
    prevImg.style.zIndex = "1";
    nextImg.style.opacity = "1";
    prevImg.style.opacity = "0";
    this.activeImgIndex = nextIndex;
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
