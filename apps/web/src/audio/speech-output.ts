import { CSA1_FLAG_LAST, OrderedGenerationQueue, parseCsa1Frame } from "./protocol";
import { createAudioLipSync, type AudioLipSync } from "@companion-space/avatar-engine/audio-lip-sync";
import type { VisemeWeights } from "@companion-space/avatar-engine/viseme";

export type SpeechFormat = "mp3" | "pcm_s16le";

export interface SpeechFrameMetadata {
  format: SpeechFormat;
  last?: boolean;
  sampleRate?: number;
}

export interface BrowserVoice {
  lang?: string;
  pitch?: number;
  rate?: number;
  voiceId?: string;
}

export interface PlayOptions {
  browserVoice?: BrowserVoice;
  text?: string;
}

export interface SpeechOutputCallbacks {
  onError?: (error: Error) => void;
  onLevel?: (level: number) => void;
  onVisemes?: (weights: VisemeWeights | null) => void;
  onSegmentEnd?: (gen: number, seg: number) => void;
  onSegmentStart?: (gen: number, seg: number) => void;
}

interface AudioPacket extends SpeechFrameMetadata {
  gen: number;
  payload: ArrayBuffer;
  seg: number;
}

interface SegmentState {
  ended: boolean;
  pending: number;
  started: boolean;
}

interface ActivePlayback {
  cleanup?: () => void;
  gen: number;
  processing: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
  seg: number;
}

function decodePcm16(context: AudioContext, payload: ArrayBuffer, sampleRate: number) {
  if (payload.byteLength % 2) throw new Error("PCM16 audio contains a partial sample.");
  const buffer = context.createBuffer(1, payload.byteLength / 2, sampleRate);
  const output = buffer.getChannelData(0);
  const input = new DataView(payload);
  for (let index = 0; index < output.length; index += 1) {
    const sample = input.getInt16(index * 2, true);
    output[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return buffer;
}

export class SpeechOutput {
  private context: AudioContext | null = null;
  private active: ActivePlayback | null = null;
  private readonly buffered = new Map<number, AudioPacket[]>();
  private readonly completeSegments = new Set<number>();
  private readonly finishingSegments = new Set<number>();
  private generation = 0;
  private readonly mp3 = new Map<number, Uint8Array[]>();
  private readonly order = new OrderedGenerationQueue<AudioPacket>();
  private scheduledUntil = 0;
  private readonly segments = new Map<number, SegmentState>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private utterance: SpeechSynthesisUtterance | null = null;
  private playbackToken = 0;
  private levelFrame = 0;
  private levelSamples: Float32Array<ArrayBuffer> | null = null;
  private lipSync: AudioLipSync | null = null;
  private lipSyncPromise: Promise<AudioLipSync | null> | null = null;

  analyser: AnalyserNode | null = null;

  constructor(private readonly callbacks: SpeechOutputCallbacks = {}) {}

  async prepare() {
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
    await this.prepareLipSync();
  }

  setGeneration(gen: number, firstSeg = 1) {
    if (gen < this.generation) return false;
    if (gen !== this.generation || firstSeg !== 1) {
      this.stop();
      this.generation = gen;
      this.order.reset(gen, firstSeg);
    }
    return true;
  }

  resetGeneration(gen: number, firstSeg = 1) {
    if (gen < this.generation) return false;
    this.stop();
    this.generation = gen;
    this.order.reset(gen, firstSeg);
    return true;
  }

  pushFrame(data: ArrayBuffer, metadata: SpeechFrameMetadata) {
    const frame = parseCsa1Frame(data);
    if (frame.gen !== this.generation) return false;
    const last = metadata.last || Boolean(frame.flags & CSA1_FLAG_LAST);
    const ready = this.order.push(frame.gen, frame.seg, {
      ...metadata,
      gen: frame.gen,
      last,
      payload: frame.payload,
      seg: frame.seg,
    }, last);
    for (const entry of ready) {
      if (entry.value) {
        entry.value.last ||= entry.last;
        this.accept(entry.value);
      }
    }
    return true;
  }

  finishSegment(gen: number, seg: number) {
    if (gen !== this.generation) return false;
    const ready = this.order.push(gen, seg, null, true);
    for (const entry of ready) {
      if (entry.value) {
        entry.value.last ||= entry.last;
        this.accept(entry.value);
      } else this.completeIncoming(entry.seg);
    }
    return true;
  }

  skipSegment(gen: number, seg: number) {
    if (gen !== this.generation) return false;
    const ready = this.order.push(gen, seg, null, true);
    for (const entry of ready) {
      if (entry.value) {
        entry.value.last ||= entry.last;
        this.accept(entry.value);
      }
    }
    return true;
  }

  play(gen: number, seg: number, options: PlayOptions = {}, signal?: AbortSignal) {
    if (gen !== this.generation) return Promise.reject(new DOMException("Stale audio generation", "AbortError"));
    if (this.active) return Promise.reject(new Error("Another speech segment is already active."));
    return new Promise<void>((resolve, reject) => {
      const active: ActivePlayback = { gen, seg, processing: Promise.resolve(), reject, resolve };
      this.active = active;
      const abort = () => this.stop(gen);
      signal?.addEventListener("abort", abort, { once: true });
      active.cleanup = () => signal?.removeEventListener("abort", abort);
      const packets = this.buffered.get(seg) ?? [];
      this.buffered.delete(seg);
      for (const packet of packets) this.processActive(active, packet);
      if (this.completeSegments.has(seg)) this.finishActiveAfterPackets(active);
      if (options.text && options.browserVoice) this.startBrowserSpeech(active, options.text, options.browserVoice);
      const state = this.segments.get(seg);
      if (state?.ended && state.pending === 0) this.completeSegment(seg, state);
    });
  }

  useBrowser(gen: number, seg: number, text: string, voice: BrowserVoice = {}, signal?: AbortSignal) {
    return this.play(gen, seg, { browserVoice: voice, text }, signal);
  }

  stop(gen?: number) {
    if (gen !== undefined && gen !== this.generation) return false;
    this.playbackToken += 1;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
      }
    }
    this.sources.clear();
    this.segments.clear();
    this.buffered.clear();
    this.completeSegments.clear();
    this.finishingSegments.clear();
    this.mp3.clear();
    if (this.context) this.scheduledUntil = this.context.currentTime;
    this.order.reset(this.generation);
    this.stopLevelMeter();
    this.cancelBrowserSpeech();
    const active = this.active;
    this.active = null;
    active?.cleanup?.();
    active?.reject(new DOMException("Speech playback was stopped", "AbortError"));
    return true;
  }

  async close() {
    this.stop();
    const context = this.context;
    this.context = null;
    this.analyser = null;
    this.lipSync?.dispose();
    this.lipSync = null;
    this.lipSyncPromise = null;
    if (context && context.state !== "closed") await context.close();
  }

  private getContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.context.destination);
      this.scheduledUntil = this.context.currentTime;
    }
    return this.context;
  }

  private prepareLipSync() {
    if (this.lipSync) return Promise.resolve(this.lipSync);
    if (!this.callbacks.onVisemes || !this.context || globalThis.isSecureContext === false) {
      return Promise.resolve(null);
    }
    this.lipSyncPromise ??= createAudioLipSync(this.context)
      .then((lipSync) => (this.lipSync = lipSync))
      .catch(() => null);
    return this.lipSyncPromise;
  }

  private async consume(packet: AudioPacket) {
    if (packet.gen !== this.generation) return;
    if (packet.format === "pcm_s16le") {
      const buffer = decodePcm16(this.getContext(), packet.payload, packet.sampleRate ?? 24000);
      this.schedule(packet, buffer);
      return;
    }
    const chunks = this.mp3.get(packet.seg) ?? [];
    chunks.push(new Uint8Array(packet.payload));
    this.mp3.set(packet.seg, chunks);
  }

  private async decodeMp3(seg: number, gen: number) {
    const chunks = this.mp3.get(seg) ?? [];
    this.mp3.delete(seg);
    if (!chunks.length) return;
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const encoded = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const context = this.getContext();
    const buffer = await context.decodeAudioData(encoded.buffer);
    if (gen === this.generation) this.schedule({ format: "mp3", gen, last: true, payload: encoded.buffer, seg }, buffer);
  }

  private accept(packet: AudioPacket) {
    if (packet.last) this.completeSegments.add(packet.seg);
    const active = this.active;
    if (active && active.gen === packet.gen && active.seg === packet.seg) {
      this.processActive(active, packet);
      if (packet.last) this.finishActiveAfterPackets(active);
      return;
    }
    const packets = this.buffered.get(packet.seg) ?? [];
    packets.push(packet);
    this.buffered.set(packet.seg, packets);
  }

  private processActive(active: ActivePlayback, packet: AudioPacket) {
    active.processing = active.processing.then(() => this.consume(packet)).catch((error: unknown) => {
      if (this.active !== active) return;
      this.active = null;
      const reported = error instanceof Error ? error : new Error(String(error));
      active.reject(reported);
      this.callbacks.onError?.(reported);
    });
  }

  private completeIncoming(seg: number) {
    this.completeSegments.add(seg);
    const active = this.active;
    if (active?.seg === seg) this.finishActiveAfterPackets(active);
  }

  private finishActiveAfterPackets(active: ActivePlayback) {
    if (this.finishingSegments.has(active.seg)) return;
    this.finishingSegments.add(active.seg);
    active.processing = active.processing.then(async () => {
      if (this.active !== active) return;
      await this.decodeMp3(active.seg, active.gen);
      this.markSegmentEnded(active.seg);
    }).finally(() => this.finishingSegments.delete(active.seg));
  }

  private schedule(packet: AudioPacket, buffer: AudioBuffer) {
    if (!buffer.length || packet.gen !== this.generation) return;
    const context = this.getContext();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    if (this.lipSync) source.connect(this.lipSync.input);
    const startAt = Math.max(context.currentTime + 0.01, this.scheduledUntil);
    const token = this.playbackToken;
    this.scheduledUntil = startAt + buffer.duration;
    const state = this.segments.get(packet.seg) ?? { ended: false, pending: 0, started: false };
    state.pending += 1;
    this.segments.set(packet.seg, state);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) this.stopLevelMeter();
      state.pending -= 1;
      if (state.ended && state.pending === 0) this.completeSegment(packet.seg, state);
    };
    this.sources.add(source);
    this.startLevelMeter();
    source.start(startAt);
    window.setTimeout(() => {
      if (token === this.playbackToken && packet.gen === this.generation && !state.started) {
        state.started = true;
        this.callbacks.onSegmentStart?.(packet.gen, packet.seg);
      }
    }, Math.max(0, (startAt - context.currentTime) * 1000));
  }

  private markSegmentEnded(seg: number) {
    const state = this.segments.get(seg) ?? { ended: false, pending: 0, started: false };
    state.ended = true;
    this.segments.set(seg, state);
    if (state.pending === 0) this.completeSegment(seg, state);
  }

  private completeSegment(seg: number, state: SegmentState) {
    if (this.segments.get(seg) !== state) return;
    this.segments.delete(seg);
    this.completeSegments.delete(seg);
    this.callbacks.onSegmentEnd?.(this.generation, seg);
    if (this.active?.seg === seg) {
      const active = this.active;
      this.active = null;
      active.cleanup?.();
      active.resolve();
    }
  }

  private startBrowserSpeech(active: ActivePlayback, text: string, voice: BrowserVoice) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      const error = new Error("Browser speech synthesis is unavailable.");
      active.reject(error);
      this.callbacks.onError?.(error);
      this.active = null;
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice.lang ?? "zh-CN";
    utterance.pitch = voice.pitch ?? 1;
    utterance.rate = voice.rate ?? 1;
    utterance.voice = window.speechSynthesis.getVoices().find((candidate) =>
      candidate.voiceURI === voice.voiceId || candidate.name === voice.voiceId
    ) ?? null;
    utterance.onstart = () => {
      if (this.utterance === utterance) this.callbacks.onSegmentStart?.(active.gen, active.seg);
    };
    utterance.onend = () => this.finishBrowserSpeech(utterance, active.gen, active.seg);
    utterance.onerror = (event) => {
      if (["canceled", "interrupted"].includes(event.error)) return;
      this.failBrowserSpeech(utterance, new Error(`Browser speech failed: ${event.error}`));
    };
    this.utterance = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      this.failBrowserSpeech(utterance, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cancelBrowserSpeech() {
    if (!this.utterance) return;
    this.utterance = null;
    window.speechSynthesis.cancel();
  }

  private finishBrowserSpeech(utterance: SpeechSynthesisUtterance, gen: number, seg: number) {
    if (this.utterance !== utterance) return;
    this.utterance = null;
    if (gen === this.generation) {
      this.callbacks.onSegmentEnd?.(gen, seg);
      const active = this.active;
      if (active?.gen === gen && active.seg === seg) {
        this.active = null;
        active.cleanup?.();
        active.resolve();
      }
    }
  }

  private failBrowserSpeech(utterance: SpeechSynthesisUtterance, error: Error) {
    if (this.utterance !== utterance) return;
    this.utterance = null;
    const active = this.active;
    this.active = null;
    active?.cleanup?.();
    active?.reject(error);
    this.callbacks.onError?.(error);
  }

  private startLevelMeter() {
    if ((!this.callbacks.onLevel && !this.callbacks.onVisemes) || this.levelFrame || !this.analyser) return;
    this.levelSamples ??= new Float32Array(this.analyser.fftSize);
    const sample = () => {
      if (!this.sources.size || !this.analyser || !this.levelSamples) {
        this.stopLevelMeter();
        return;
      }
      this.analyser.getFloatTimeDomainData(this.levelSamples);
      let energy = 0;
      for (const value of this.levelSamples) energy += value * value;
      this.callbacks.onLevel?.(Math.min(1, Math.sqrt(energy / this.levelSamples.length) * 4));
      this.callbacks.onVisemes?.(this.lipSync?.read().weights ?? null);
      this.levelFrame = requestAnimationFrame(sample);
    };
    this.levelFrame = requestAnimationFrame(sample);
  }

  private stopLevelMeter() {
    if (this.levelFrame) cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;
    this.callbacks.onLevel?.(0);
    this.callbacks.onVisemes?.(null);
  }
}
