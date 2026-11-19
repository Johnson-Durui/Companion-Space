import type {
  InstantAction,
  ITutorVideoDriver,
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
    const root = document.createElement("div");
    root.className = "tvb-surface tvb-static";
    root.dataset.tier = "static";
    root.dataset.pose = "idle_companion";
    root.dataset.emotion = "neutral";
    root.style.setProperty("--speech-level", "0");

    const halo = document.createElement("span");
    halo.className = "tvb-halo";
    halo.setAttribute("aria-hidden", "true");

    const img = document.createElement("img");
    img.className = "tvb-anchor";
    img.src = config.anchorImage;
    img.alt = config.name;
    img.decoding = "async";

    root.append(halo, img);
    container.replaceChildren(root);
    this.root = root;
    this.emitStatus({ state: "ready", tier: "static" });
  }

  async unmount(): Promise<void> {
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
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
    if (this.root) {
      this.root.dataset.pose = pose;
    }
  }

  setMood(emotion: TutorEmotion, _intensity: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) {
      this.root.dataset.emotion = emotion;
    }
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (!this.root) return;
    this.root.dataset.action = action;
    if (this.actionTimer !== null) window.clearTimeout(this.actionTimer);
    this.actionTimer = window.setTimeout(() => {
      if (this.root && this.root.dataset.action === action) {
        delete this.root.dataset.action;
      }
      this.actionTimer = null;
    }, 1800);
  }

  interrupt(gen: number): void {
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.actionTimer !== null) {
      window.clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    if (this.root) {
      delete this.root.dataset.action;
      this.root.dataset.pose = "listening_empathy";
      this.root.style.setProperty("--speech-level", "0");
    }
  }

  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
