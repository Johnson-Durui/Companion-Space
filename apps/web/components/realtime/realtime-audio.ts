const DEFAULT_INPUT_SAMPLE_RATE = 16000;
const INPUT_FRAME_DURATION_MS = 20;
const PCM16_MAX = 0x7fff;
const PCM16_MIN = -0x8000;

export const INPUT_PCM16_SAMPLE_RATE = 16000;
export const INPUT_PCM16_FRAME_SAMPLES = (INPUT_PCM16_SAMPLE_RATE * INPUT_FRAME_DURATION_MS) / 1000;
export const INPUT_PCM16_FRAME_BYTES = INPUT_PCM16_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
export const OUTPUT_PCM16_SAMPLE_RATE = 24000;

function clampSample(sample: number) {
  if (Number.isNaN(sample)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, sample));
}

function toPcm16(sample: number) {
  const normalized = clampSample(sample);
  return normalized < 0
    ? Math.round(normalized * -PCM16_MIN)
    : Math.round(normalized * PCM16_MAX);
}

function toFloat32Sample(sample: number) {
  return sample < 0 ? sample / -PCM16_MIN : sample / PCM16_MAX;
}

function decodeLittleEndianPcm16(chunk: ArrayBuffer) {
  const view = new DataView(chunk);
  const samples = new Int16Array(chunk.byteLength / Int16Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true);
  }
  return samples;
}

export function measureLevel(samples: Float32Array | readonly number[]) {
  if (!samples.length) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export class Pcm16MonoFramer {
  private inputBuffer: number[] = [];

  private outputBuffer: number[] = [];

  private sourceIndex = 0;

  private readonly sourceStep: number;

  constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate = INPUT_PCM16_SAMPLE_RATE,
    private readonly frameSamples = INPUT_PCM16_FRAME_SAMPLES,
  ) {
    const safeInputSampleRate =
      Number.isFinite(inputSampleRate) && inputSampleRate > 0
        ? inputSampleRate
        : DEFAULT_INPUT_SAMPLE_RATE;
    this.sourceStep = safeInputSampleRate / outputSampleRate;
  }

  push(samples: Float32Array | readonly number[]) {
    for (const sample of samples) {
      this.inputBuffer.push(clampSample(sample));
    }

    const frames: ArrayBuffer[] = [];
    while (this.sourceIndex + 1 < this.inputBuffer.length) {
      const lowerIndex = Math.floor(this.sourceIndex);
      const upperIndex = lowerIndex + 1;
      const fraction = this.sourceIndex - lowerIndex;
      const lower = this.inputBuffer[lowerIndex] ?? 0;
      const upper = this.inputBuffer[upperIndex] ?? lower;
      const resampled = lower + (upper - lower) * fraction;
      this.outputBuffer.push(toPcm16(resampled));
      this.sourceIndex += this.sourceStep;
    }

    const consumed = Math.floor(this.sourceIndex);
    if (consumed > 0) {
      this.inputBuffer.splice(0, consumed);
      this.sourceIndex -= consumed;
    }

    while (this.outputBuffer.length >= this.frameSamples) {
      const frame = new Int16Array(this.frameSamples);
      frame.set(this.outputBuffer.splice(0, this.frameSamples));
      frames.push(frame.buffer);
    }

    return frames;
  }

  reset() {
    this.inputBuffer = [];
    this.outputBuffer = [];
    this.sourceIndex = 0;
  }
}

export class Pcm16PlaybackQueue {
  private audioContext: AudioContext | null = null;

  private readonly activeLevels = new Map<AudioBufferSourceNode, number>();

  private generation = 0;

  private readonly levelTimers = new Set<number>();

  private pendingSourceCount = 0;

  private readonly activeSources = new Set<AudioBufferSourceNode>();

  private scheduledUntil = 0;

  constructor(
    private readonly sampleRate = OUTPUT_PCM16_SAMPLE_RATE,
    private readonly onDrained?: () => void,
    private readonly onLevel?: (level: number) => void,
    private readonly onPlaybackStart?: (scheduledDelayMs: number) => void,
  ) {}

  private emitActiveLevel() {
    let activeLevel = 0;
    for (const level of this.activeLevels.values()) {
      activeLevel = Math.max(activeLevel, level);
    }
    this.onLevel?.(activeLevel);
  }

  private scheduleLevelChange(callback: () => void, delayMs: number) {
    const timerId = window.setTimeout(() => {
      this.levelTimers.delete(timerId);
      callback();
    }, Math.max(0, delayMs));
    this.levelTimers.add(timerId);
  }

  private ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new window.AudioContext();
      this.scheduledUntil = this.audioContext.currentTime;
    }
    return this.audioContext;
  }

  async prepare() {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  hasPendingAudio() {
    if (!this.audioContext) {
      return false;
    }
    return (
      this.pendingSourceCount > 0 ||
      this.scheduledUntil - this.audioContext.currentTime > 0.01
    );
  }

  enqueue(chunk: ArrayBuffer) {
    if (!chunk.byteLength) {
      return;
    }
    if (chunk.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("TTS 二进制帧不是有效的 PCM16 单声道数据。");
    }

    const context = this.ensureContext();
    const pcm16 = decodeLittleEndianPcm16(chunk);
    const buffer = context.createBuffer(1, pcm16.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm16.length; index += 1) {
      channel[index] = toFloat32Sample(pcm16[index] ?? 0);
    }
    const level = measureLevel(channel);

    const generation = this.generation;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime + 0.01, this.scheduledUntil);
    const startDelayMs = Math.max(0, (startAt - context.currentTime) * 1000);
    const isFirstPendingSource = this.pendingSourceCount === 0;
    this.scheduledUntil = startAt + buffer.duration;
    this.pendingSourceCount += 1;
    this.activeSources.add(source);
    this.scheduleLevelChange(() => {
      if (generation !== this.generation) {
        return;
      }
      this.activeLevels.set(source, level);
      this.emitActiveLevel();
    }, startDelayMs);
    source.onended = () => {
      this.activeSources.delete(source);
      this.activeLevels.delete(source);
      this.emitActiveLevel();
      this.pendingSourceCount = Math.max(0, this.pendingSourceCount - 1);
      if (generation !== this.generation) {
        return;
      }
      if (this.pendingSourceCount === 0) {
        this.scheduledUntil = Math.max(this.scheduledUntil, context.currentTime);
        this.onLevel?.(0);
        this.onDrained?.();
      }
    };
    source.start(startAt);
    if (isFirstPendingSource) {
      const playbackDelayMs = Math.max(0, (startAt - context.currentTime) * 1000);
      this.onPlaybackStart?.(playbackDelayMs);
    }
  }

  clear() {
    this.generation += 1;
    this.pendingSourceCount = 0;
    this.activeLevels.clear();
    for (const timerId of this.levelTimers) {
      window.clearTimeout(timerId);
    }
    this.levelTimers.clear();
    if (!this.audioContext) {
      this.onLevel?.(0);
      return;
    }
    this.scheduledUntil = this.audioContext.currentTime;
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch (error) {
        if (error instanceof DOMException && error.name === "InvalidStateError") {
          console.warn("Skipping stop on an already-ended audio source.", error);
          continue;
        }
        throw error;
      }
    }
    this.activeSources.clear();
    this.onLevel?.(0);
  }

  async close() {
    this.clear();
    const context = this.audioContext;
    this.audioContext = null;
    if (context) {
      await context.close();
    }
  }
}
