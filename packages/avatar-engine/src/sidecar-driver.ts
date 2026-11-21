import type {
  DecodedSpeechChunk,
  InstantAction,
  ITutorVideoDriver,
  SidecarSessionConnector,
  SidecarSessionHandle,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoDriverCapabilities,
  VideoDriverDegradedCode,
  VideoDriverStatusEvent,
} from "./types";

export const TSVA_MAGIC = [0x54, 0x53, 0x56, 0x41] as const; // "TSVA"
export const TSVF_MAGIC = [0x54, 0x53, 0x56, 0x46] as const; // "TSVF"
export const TSV_HEADER_BYTES = 16;

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

export function encodeTsvaFrame(chunk: DecodedSpeechChunk): ArrayBuffer {
  const payload = new Uint8Array(chunk.pcm16);
  const buffer = new ArrayBuffer(TSV_HEADER_BYTES + payload.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(TSVA_MAGIC, 0);
  bytes.set(payload, TSV_HEADER_BYTES);
  const view = new DataView(buffer);
  view.setUint32(4, chunk.gen >>> 0, false);
  view.setUint32(8, chunk.seg >>> 0, false);
  view.setUint16(12, chunk.last ? 1 : 0, false);
  view.setUint16(14, chunk.sampleRate, false);
  return buffer;
}

export interface DecodedTsvfFrame {
  gen: number;
  tsMs: number;
  mimeType: "image/webp" | "image/jpeg";
  flags: number;
  payload: Uint8Array<ArrayBuffer>;
}

export function decodeTsvfFrame(buffer: ArrayBuffer): DecodedTsvfFrame | null {
  if (buffer.byteLength <= TSV_HEADER_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  if (
    bytes[0] !== TSVF_MAGIC[0] ||
    bytes[1] !== TSVF_MAGIC[1] ||
    bytes[2] !== TSVF_MAGIC[2] ||
    bytes[3] !== TSVF_MAGIC[3]
  ) {
    return null;
  }
  const view = new DataView(buffer);
  const gen = view.getUint32(4, false);
  const tsMs = view.getUint32(8, false);
  const codec = view.getUint16(12, false);
  const flags = view.getUint16(14, false);
  const mimeType = codec === 2 ? "image/jpeg" : "image/webp";
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength - TSV_HEADER_BYTES));
  copy.set(bytes.subarray(TSV_HEADER_BYTES));
  return {
    gen,
    tsMs,
    mimeType,
    flags,
    payload: copy,
  };
}

export class LocalSidecarVideoDriver implements ITutorVideoDriver {
  readonly id = "local-gpu-sidecar";
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private session: SidecarSessionHandle | null = null;
  private currentGen = 0;
  private listeners = new Set<(event: VideoDriverStatusEvent) => void>();
  private heartbeatTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private lastActivityMs = 0;
  private degraded = false;
  private rendering = false;

  constructor(
    private readonly connector: SidecarSessionConnector,
    private readonly options: { watchdogMs?: number; heartbeatMs?: number } = {},
  ) {}

  getCapabilities(): VideoDriverCapabilities {
    return {
      tier: "local_sidecar",
      lipSyncQuality: "realtime_neural",
      supportsInstantActions: ALL_ACTIONS,
      supportsCustomActionPrompt: false,
      hasMeteredCost: false,
    };
  }

  async mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void> {
    await this.unmount();
    this.degraded = false;
    this.emitStatus({ state: "connecting", tier: "local_sidecar" });

    const root = document.createElement("div");
    root.className = "tvb-surface tvb-sidecar";
    root.dataset.tier = "local_sidecar";
    root.dataset.pose = "idle_companion";
    root.dataset.emotion = "neutral";
    root.style.setProperty("--speech-level", "0");

    const anchor = document.createElement("img");
    anchor.className = "tvb-anchor";
    anchor.src = config.anchorImage;
    anchor.alt = config.name;
    anchor.decoding = "async";

    const canvas = document.createElement("canvas");
    canvas.className = "tvb-canvas";
    canvas.setAttribute("aria-hidden", "true");

    const video = document.createElement("video");
    video.className = "tvb-video";
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.opacity = "0";
    video.setAttribute("aria-hidden", "true");

    root.append(anchor, canvas, video);
    container.replaceChildren(root);
    this.root = root;
    this.canvas = canvas;
    this.video = video;

    try {
      const sidecar = config.localSidecar;
      const handle = await this.connector.openSession({
        characterId: config.characterId,
        driverId: sidecar?.driverId ?? null,
        aspectRatio: config.aspectRatio,
        fps: sidecar?.fps ?? 25,
        resolution: sidecar?.resolution ?? "512x896",
      });
      if (this.root !== root) {
        await handle.close();
        return;
      }
      this.session = handle;

      if (handle.transport === "webrtc" && handle.sdpAnswer && typeof RTCPeerConnection !== "undefined") {
        await this.attachWebRtc(handle.sdpAnswer, video);
      }

      const ws = handle.wsProtocols?.length
        ? new WebSocket(handle.streamUrl, handle.wsProtocols)
        : new WebSocket(handle.streamUrl);
      ws.binaryType = "arraybuffer";
      this.socket = ws;
      this.lastActivityMs = Date.now();

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(Object.assign(new Error("Sidecar stream connect timed out."), { code: "sidecar_timeout" as const })),
          4000,
        );
        ws.onopen = () => {
          window.clearTimeout(timeout);
          this.lastActivityMs = Date.now();
          this.startTimers();
          this.emitStatus({ state: "ready", tier: "local_sidecar" });
          resolve();
        };
        ws.onerror = () => {
          window.clearTimeout(timeout);
          reject(Object.assign(new Error("Sidecar stream connection failed."), { code: "sidecar_connect_failed" as const }));
        };
      });

      ws.onmessage = (event) => this.handleMessage(event);
      ws.onclose = () => {
        if (!this.degraded && this.root === root) {
          this.triggerDegrade("sidecar_disconnected", "Local GPU sidecar stream disconnected.");
        }
      };
      ws.onerror = () => {
        if (!this.degraded && this.root === root) {
          this.triggerDegrade("sidecar_stream_error", "Local GPU sidecar stream error.");
        }
      };
    } catch (error) {
      const code = (error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "sidecar_unavailable") as VideoDriverDegradedCode;
      const reason = error instanceof Error ? error.message : "Local GPU sidecar unavailable.";
      this.triggerDegrade(code, reason);
    }
  }

  async unmount(): Promise<void> {
    this.degraded = true;
    this.stopTimers();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    const session = this.session;
    this.session = null;
    if (session) {
      await session.close().catch(() => undefined);
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
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

  pushSpeechChunk(chunk: DecodedSpeechChunk): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (chunk.gen < this.currentGen) return;
    if (this.socket.bufferedAmount > 512_000) return;
    this.socket.send(encodeTsvaFrame(chunk));
  }

  setPose(pose: TutorPose, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.pose = pose;
    this.sendControl("pose", this.currentGen, { pose });
  }

  setMood(emotion: TutorEmotion, intensity: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.emotion = emotion;
    this.sendControl("mood", this.currentGen, { emotion, intensity });
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.action = action;
    this.sendControl("instant_action", this.currentGen, { action });
  }

  interrupt(gen: number): void {
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) {
      delete this.root.dataset.action;
      this.root.dataset.pose = "listening_empathy";
      this.root.style.setProperty("--speech-level", "0");
    }
    this.sendControl("interrupt", this.currentGen, {});
  }

  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async attachWebRtc(sdpAnswer: string, video: HTMLVideoElement): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        video.srcObject = stream;
        video.style.opacity = "1";
        void video.play().catch(() => undefined);
      }
    };
    await peer.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
  }

  private handleMessage(event: MessageEvent): void {
    this.lastActivityMs = Date.now();
    if (event.data instanceof ArrayBuffer) {
      const frame = decodeTsvfFrame(event.data);
      if (frame && frame.gen >= this.currentGen) {
        void this.renderCanvasFrame(frame);
      }
      return;
    }
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data) as { type?: string; message?: string };
        if (msg.type === "error") {
          this.triggerDegrade("sidecar_remote_error", msg.message || "Local GPU sidecar reported an error.");
        }
      } catch {
        // Ignore malformed control responses.
      }
    }
  }

  private async renderCanvasFrame(frame: DecodedTsvfFrame): Promise<void> {
    if (!this.canvas || this.rendering) return;
    this.rendering = true;
    try {
      const blob = new Blob([frame.payload], { type: frame.mimeType });
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        if (!this.canvas) {
          bitmap.close();
          return;
        }
        if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
          this.canvas.width = bitmap.width;
          this.canvas.height = bitmap.height;
        }
        const ctx = this.canvas.getContext("2d");
        ctx?.drawImage(bitmap, 0, 0);
        bitmap.close();
        this.canvas.style.opacity = "1";
      }
    } catch {
      // Drop corrupt frame without crashing session.
    } finally {
      this.rendering = false;
    }
  }

  private sendControl(type: string, gen: number, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, gen, payload }));
  }

  private startTimers(): void {
    this.stopTimers();
    const heartbeatMs = this.options.heartbeatMs ?? 1500;
    const watchdogMs = this.options.watchdogMs ?? 3000;
    this.heartbeatTimer = window.setInterval(() => {
      this.sendControl("ping", this.currentGen, { t: Date.now() });
    }, heartbeatMs);
    this.watchdogTimer = window.setInterval(() => {
      if (Date.now() - this.lastActivityMs > watchdogMs) {
        this.triggerDegrade("sidecar_heartbeat_timeout", "Local GPU sidecar heartbeat timed out.");
      }
    }, 500);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private triggerDegrade(code: VideoDriverDegradedCode, reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.stopTimers();
    this.emitStatus({
      state: "degraded",
      tier: "local_sidecar",
      code,
      reason,
      fallbackTier: "loop_pack",
    });
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
