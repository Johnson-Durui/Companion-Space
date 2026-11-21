export type VideoAvatarTier = "static" | "loop_pack" | "local_sidecar" | "cloud_live";

export type TutorPose =
  | "greeting"
  | "lecturing"
  | "board_guiding"
  | "listening_empathy"
  | "feedback_reaction"
  | "idle_companion";

export type InstantAction =
  | "greet"
  | "empathy_nod"
  | "think_chin"
  | "praise_thumbs_up"
  | "praise_clap"
  | "gentle_encourage"
  | "board_point"
  | "farewell";

export type ClipSlot =
  | "idle_breathe"
  | "listen_nod"
  | "think_chin"
  | "speak_explain_a"
  | "speak_explain_b"
  | "board_point"
  | "react_praise"
  | "react_comfort";

export const CLIP_SLOTS: readonly ClipSlot[] = [
  "idle_breathe",
  "listen_nod",
  "think_chin",
  "speak_explain_a",
  "speak_explain_b",
  "board_point",
  "react_praise",
  "react_comfort",
] as const;

export type TutorEmotion =
  | "neutral"
  | "warm"
  | "cheerful"
  | "curious"
  | "focused"
  | "playful"
  | "concerned";

export interface LoopPackConfig {
  crossfadeMs: number;
  clips: Partial<Record<ClipSlot, string>>;
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
  interrupt(gen: number): void;
  suspend?(reason: string): Promise<void>;
  resume?(): Promise<void>;
  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void;
  onCostTick?(cb: (event: VideoDriverCostEvent) => void): () => void;
}
