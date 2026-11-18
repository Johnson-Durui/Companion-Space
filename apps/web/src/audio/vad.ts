import { MicVAD } from "@ricky0123/vad-web";

const ASSET_PATH = "/audio/vad/";
const FRAME_MS = 32;

export interface HandsFreeVadCallbacks {
  onFrame: (samples: Float32Array) => void;
  onInterrupt: () => void;
  onMisfire?: () => void;
  onSpeechEnd: () => void;
  onSpeechStart?: () => void;
}

export class HandsFreeVad {
  private capturing = false;
  private destroyed = false;
  private instance: MicVAD | null = null;
  private readonly preroll: Float32Array[] = [];

  constructor(private readonly callbacks: HandsFreeVadCallbacks) {}

  async start() {
    if (this.destroyed) return;
    if (!this.instance) {
      const instance = await MicVAD.new({
        baseAssetPath: ASSET_PATH,
        model: "v5",
        minSpeechMs: 300,
        onFrameProcessed: (_probabilities, frame) => this.handleFrame(frame),
        onSpeechEnd: () => {
          this.capturing = false;
          this.preroll.length = 0;
          this.callbacks.onSpeechEnd();
        },
        onSpeechRealStart: this.callbacks.onInterrupt,
        onSpeechStart: () => {
          this.capturing = true;
          this.callbacks.onSpeechStart?.();
          for (const frame of this.preroll) this.callbacks.onFrame(frame);
          this.preroll.length = 0;
        },
        onVADMisfire: () => {
          this.capturing = false;
          this.preroll.length = 0;
          this.callbacks.onMisfire?.();
        },
        onnxWASMBasePath: ASSET_PATH,
        preSpeechPadMs: 300,
        processorType: "AudioWorklet",
        redemptionMs: 800,
        startOnLoad: false,
        getStream: async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true },
          });
          if (this.destroyed) {
            stream.getTracks().forEach((track) => track.stop());
            throw new DOMException("Microphone capture was stopped", "AbortError");
          }
          return stream;
        },
      });
      if (this.destroyed) { await instance.destroy(); return; }
      this.instance = instance;
    }
    await this.instance.start();
  }

  async destroy() {
    this.destroyed = true;
    const instance = this.instance;
    this.instance = null;
    this.capturing = false;
    this.preroll.length = 0;
    await instance?.destroy();
  }

  private handleFrame(frame: Float32Array) {
    if (this.capturing) {
      this.callbacks.onFrame(frame);
      return;
    }
    this.preroll.push(frame.slice());
    const maxFrames = Math.ceil(300 / FRAME_MS);
    if (this.preroll.length > maxFrames) this.preroll.shift();
  }
}
