import type { ClipSlot, StillSlot } from "./catalog";

export {
  ACTIVE_CLIP_SLOTS,
  CLIP_CATALOG,
  CLIP_SLOTS,
  LEGACY_CLIP_SLOTS,
  STILL_LOCATIONS,
  STILL_SLOTS,
  type ClipCatalogEntry,
  type ClipGroup,
  type ClipKind,
  type ClipMissingBehavior,
  type ClipSlot,
  type StillLocation,
  type StillSlot,
} from "./catalog";

export type VideoAvatarTier = "static" | "loop_pack" | "local_sidecar" | "cloud_live";

export type TutorPose =
  | "greeting"
  | "lecturing"
  | "board_guiding"
  | "listening_empathy"
  | "thinking"
  | "feedback_reaction"
  | "idle_companion";

export type LessonPhase =
  | "loading"
  | "preparing"
  | "lobby"
  | "connecting"
  | "thinking"
  | "buffering"
  | "speaking"
  | "listening"
  | "awaiting"
  | "judging"
  | "feedback"
  | "paused"
  | "reconnecting"
  | "ending"
  | "ended"
  | "failed";

export type Situation =
  | "loading"
  | "preparing"
  | "idle"
  | "thinking"
  | "speaking"
  | "speaking_board"
  | "listening"
  | "wait"
  | "review"
  | "paused"
  | "frozen"
  | "ended";

export type OneShotKind =
  | "greet"
  | "praise"
  | "surprise"
  | "comfort"
  | "encourage"
  | "hint"
  | "ack"
  | "board_glance"
  | "board_point"
  | "farewell"
  | "celebrate";

export type InstantAction =
  | "greet"
  | "empathy_nod"
  | "think_chin"
  | "praise_thumbs_up"
  | "praise_clap"
  | "gentle_encourage"
  | "board_point"
  | "farewell";

export type TutorEmotion =
  | "neutral"
  | "warm"
  | "cheerful"
  | "curious"
  | "focused"
  | "playful"
  | "concerned";

export interface PackCanvas {
  width: number;
  height: number;
  fps: number;
}

export interface ClipMeta {
  settleMs?: number;
  durationMs?: number;
}

export interface PackMediaInfo {
  generator?: string;
  aiGenerated?: boolean;
  imageGenerator?: string | null;
  videoGenerator?: string | null;
}

export interface LoopPackConfig {
  crossfadeMs: number;
  canvas?: PackCanvas;
  clips: Partial<Record<ClipSlot, string>>;
  clipMeta?: Partial<Record<ClipSlot, ClipMeta>>;
  stills?: Partial<Record<StillSlot, string>>;
  media?: PackMediaInfo;
}

export interface LocalSidecarConfig {
  driverId: string | null;
  fps: number;
  resolution: string;
}

export interface CloudLiveConfig {
  connectionId: string | null;
  model: string | null;
  idleSuspendSec: number;
  maxSessionMinutes: number;
  maxSessionCostCny: number;
  costPerMinuteCny?: number;
  actionPrompts?: Record<string, string>;
}

export interface VideoAvatarRuntimeConfig {
  characterId: string;
  name: string;
  aspectRatio: "9:16" | "3:4";
  preferredTier: VideoAvatarTier;
  anchorImage: string;
  loopPack: LoopPackConfig;
  localSidecar?: LocalSidecarConfig;
  cloudLive?: CloudLiveConfig;
  reducedMotion?: boolean;
  /** Injectable PRNG returning [0, 1) for deterministic testing of idle scheduler & speaking rotation. */
  random?: () => number;
  /** Disable idle insertion scheduler in compact / non-classroom surfaces (§4.2). */
  disableIdleScheduler?: boolean;
}

export interface VideoDriverCapabilities {
  tier: VideoAvatarTier;
  lipSyncQuality: "ambient" | "mouth_overlay" | "realtime_neural";
  supportsInstantActions: readonly InstantAction[];
  supportsCustomActionPrompt: boolean;
  hasMeteredCost: boolean;
}

export type VideoDriverDegradedCode =
  | "loop_pack_empty"
  | "loop_pack_playback_failed"
  | "sidecar_timeout"
  | "sidecar_connect_failed"
  | "sidecar_disconnected"
  | "sidecar_stream_error"
  | "sidecar_unavailable"
  | "sidecar_remote_error"
  | "sidecar_heartbeat_timeout"
  | "switched_to_free";

export interface VideoDriverStatusEvent {
  state: "connecting" | "ready" | "suspended" | "degraded";
  tier: VideoAvatarTier;
  code?: VideoDriverDegradedCode;
  reason?: string;
  fallbackTier?: VideoAvatarTier;
}

export interface VideoDriverCostEvent {
  activeSec: number;
  estimatedCostCny?: number;
  suspended: boolean;
}

export interface DecodedSpeechChunk {
  gen: number;
  seg: number;
  pcm16: ArrayBuffer;
  sampleRate: 24000;
  last?: boolean;
}

export interface SidecarSessionHandle {
  sessionId: string;
  transport: "webrtc" | "ws_frames";
  sdpAnswer?: string | null;
  streamUrl: string;
  wsProtocols?: string[];
  close: () => Promise<void>;
}

export interface SidecarSessionConnector {
  openSession: (params: {
    characterId: string;
    driverId: string | null;
    aspectRatio: "9:16" | "3:4";
    fps: number;
    resolution: string;
    sdpOffer?: string;
  }) => Promise<SidecarSessionHandle>;
}

export interface ITutorVideoDriver {
  readonly id: string;
  getCapabilities(): VideoDriverCapabilities;
  mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void>;
  unmount(): Promise<void>;
  pushSpeechLevel(level: number): void;
  pushSpeechChunk?(chunk: DecodedSpeechChunk): void;
  setPose(pose: TutorPose, gen: number): void;
  setMood(emotion: TutorEmotion, intensity: number, gen: number): void;
  triggerInstantAction(action: InstantAction, gen: number): void;
  setSituation?(situation: Situation, sentenceSeq: number, gen: number): void;
  triggerOneShot?(kind: OneShotKind, gen: number): void;
  playClip?(slot: ClipSlot, gen: number): void;
  showStill?(still: StillSlot | "anchor"): void;
  interrupt(gen: number): void;
  suspend?(reason: string): Promise<void>;
  resume?(): Promise<void>;
  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void;
  onCostTick?(cb: (event: VideoDriverCostEvent) => void): () => void;
}
