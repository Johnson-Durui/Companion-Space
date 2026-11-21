import { LoopPackVideoDriver, resolveClipUrl } from "./loop-pack-driver";
import { LocalSidecarVideoDriver } from "./sidecar-driver";
import { StaticPortraitDriver } from "./static-driver";
import type {
  DecodedSpeechChunk,
  InstantAction,
  ITutorVideoDriver,
  SidecarSessionConnector,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoAvatarTier,
  VideoDriverDegradedCode,
  VideoDriverStatusEvent,
} from "./types";

export interface DriverManagerOptions {
  sidecarConnector?: SidecarSessionConnector;
  cloudDriverFactory?: () => ITutorVideoDriver;
  onStatusChange?: (event: VideoDriverStatusEvent) => void;
}

export class VideoDriverManager {
  private container: HTMLElement | null = null;
  private config: VideoAvatarRuntimeConfig | null = null;
  private driver: ITutorVideoDriver | null = null;
  private unsubscribe: (() => void) | null = null;
  private activeTier: VideoAvatarTier = "static";
  private lastPose: TutorPose = "idle_companion";
  private lastEmotion: TutorEmotion = "neutral";
  private lastGen = 0;
  private mountVersion = 0;

  constructor(private readonly options: DriverManagerOptions = {}) {}

  get currentTier(): VideoAvatarTier {
    return this.activeTier;
  }

  async mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void> {
    this.container = container;
    this.config = config;
    const version = ++this.mountVersion;
    const initialTier = this.selectStartTier(config);
    await this.activateTier(initialTier, version);
  }

  async switchToFreeTier(reason = "Switched to local free tier.", code: VideoDriverDegradedCode = "switched_to_free"): Promise<void> {
    if (!this.config || !this.container) return;
    const target = this.hasPlayableClips(this.config) ? "loop_pack" : "static";
    const version = ++this.mountVersion;
    await this.activateTier(target, version, reason, code);
  }

  async unmount(): Promise<void> {
    this.mountVersion += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.driver) {
      await this.driver.unmount();
      this.driver = null;
    }
    this.container = null;
    this.config = null;
  }

  pushSpeechLevel(level: number): void {
    this.driver?.pushSpeechLevel(level);
  }

  pushSpeechChunk(chunk: DecodedSpeechChunk): void {
    this.driver?.pushSpeechChunk?.(chunk);
  }

  setPose(pose: TutorPose, gen: number): void {
    if (gen > 0 && gen < this.lastGen) return;
    this.lastGen = Math.max(this.lastGen, gen);
    this.lastPose = pose;
    this.driver?.setPose(pose, this.lastGen);
  }

  setMood(emotion: TutorEmotion, intensity: number, gen: number): void {
    if (gen > 0 && gen < this.lastGen) return;
    this.lastGen = Math.max(this.lastGen, gen);
    this.lastEmotion = emotion;
    this.driver?.setMood(emotion, intensity, this.lastGen);
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.lastGen) return;
    this.lastGen = Math.max(this.lastGen, gen);
    this.driver?.triggerInstantAction(action, this.lastGen);
  }

  interrupt(gen: number): void {
    this.lastGen = Math.max(this.lastGen, gen);
    this.lastPose = "listening_empathy";
    this.driver?.interrupt(this.lastGen);
  }

  private hasPlayableClips(config: VideoAvatarRuntimeConfig): boolean {
    return Boolean(resolveClipUrl(config.loopPack.clips, "idle_breathe"));
  }

  private selectStartTier(config: VideoAvatarRuntimeConfig): VideoAvatarTier {
    if (config.preferredTier === "cloud_live" && this.options.cloudDriverFactory) {
      return "cloud_live";
    }
    if (config.preferredTier === "local_sidecar" && this.options.sidecarConnector) {
      return "local_sidecar";
    }
    if (
      (config.preferredTier === "loop_pack" ||
        config.preferredTier === "local_sidecar" ||
        config.preferredTier === "cloud_live") &&
      this.hasPlayableClips(config)
    ) {
      return "loop_pack";
    }
    return "static";
  }

  private nextFallbackTier(failed: VideoAvatarTier, config: VideoAvatarRuntimeConfig): VideoAvatarTier {
    if (failed === "cloud_live") {
      if (this.options.sidecarConnector && config.localSidecar?.driverId) return "local_sidecar";
      return this.hasPlayableClips(config) ? "loop_pack" : "static";
    }
    if (failed === "local_sidecar") {
      return this.hasPlayableClips(config) ? "loop_pack" : "static";
    }
    return "static";
  }

  private createDriver(tier: VideoAvatarTier): ITutorVideoDriver {
    if (tier === "cloud_live" && this.options.cloudDriverFactory) {
      return this.options.cloudDriverFactory();
    }
    if (tier === "local_sidecar" && this.options.sidecarConnector) {
      return new LocalSidecarVideoDriver(this.options.sidecarConnector);
    }
    if (tier === "loop_pack") {
      return new LoopPackVideoDriver();
    }
    return new StaticPortraitDriver();
  }

  private async activateTier(
    tier: VideoAvatarTier,
    version: number,
    degradedReason?: string,
    degradedCode?: VideoDriverDegradedCode,
  ): Promise<void> {
    if (!this.container || !this.config || version !== this.mountVersion) return;

    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.driver) {
      await this.driver.unmount();
      this.driver = null;
    }
    if (version !== this.mountVersion || !this.container || !this.config) return;

    const driver = this.createDriver(tier);
    this.driver = driver;
    this.activeTier = tier;

    this.unsubscribe = driver.onStatusChange((event) => {
      if (version !== this.mountVersion || this.driver !== driver) return;
      if (event.state === "degraded" && tier !== "static" && this.config) {
        const fallback = this.nextFallbackTier(tier, this.config);
        this.options.onStatusChange?.({
          state: "degraded",
          tier,
          code: event.code,
          reason: event.reason,
          fallbackTier: fallback,
        });
        void this.activateTier(fallback, version, event.reason, event.code);
        return;
      }
      this.options.onStatusChange?.(
        (degradedReason || degradedCode) && event.state === "ready"
          ? { ...event, code: degradedCode ?? event.code, reason: degradedReason ?? event.reason }
          : event,
      );
    });

    await driver.mount(this.container, this.config);
    if (version !== this.mountVersion || this.driver !== driver) return;
    driver.setMood(this.lastEmotion, 1, this.lastGen);
    driver.setPose(this.lastPose, this.lastGen);
  }
}
