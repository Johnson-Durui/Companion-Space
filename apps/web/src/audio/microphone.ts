const OUTPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;

export interface MicrophoneFrame {
  level: number;
  pcm16: ArrayBuffer;
}

function workletSource() {
  return `
class CompanionCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples?.length) {
      const copy = new Float32Array(samples);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("companion-capture", CompanionCaptureProcessor);`;
}

export class Pcm16Framer {
  private input: number[] = [];
  private output: number[] = [];
  private position = 0;
  private filtered = 0;
  private readonly alpha: number;
  private readonly step: number;

  constructor(private readonly inputSampleRate: number) {
    this.step = inputSampleRate / OUTPUT_SAMPLE_RATE;
    const cutoff = Math.min(7200, OUTPUT_SAMPLE_RATE * 0.45);
    const dt = 1 / inputSampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    this.alpha = dt / (rc + dt);
  }

  push(samples: Float32Array): MicrophoneFrame[] {
    for (const sample of samples) {
      const safe = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      this.filtered += this.alpha * (safe - this.filtered);
      this.input.push(this.filtered);
    }
    while (this.position + 1 < this.input.length) {
      const lower = Math.floor(this.position);
      const fraction = this.position - lower;
      const sample = (this.input[lower] ?? 0) * (1 - fraction) + (this.input[lower + 1] ?? 0) * fraction;
      this.output.push(sample);
      this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    if (consumed) {
      this.input.splice(0, consumed);
      this.position -= consumed;
    }
    const frames: MicrophoneFrame[] = [];
    while (this.output.length >= FRAME_SAMPLES) {
      const samples16 = new Int16Array(FRAME_SAMPLES);
      let sum = 0;
      for (let index = 0; index < FRAME_SAMPLES; index += 1) {
        const sample = this.output[index] ?? 0;
        sum += sample * sample;
        samples16[index] = Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff));
      }
      this.output.splice(0, FRAME_SAMPLES);
      frames.push({ level: Math.sqrt(sum / FRAME_SAMPLES), pcm16: samples16.buffer });
    }
    return frames;
  }
}

export class MicrophoneCapture {
  private revision = 0;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;

  async start(onFrame: (frame: MicrophoneFrame) => void) {
    const revision = ++this.revision;
    await this.release();
    if (revision !== this.revision) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (revision !== this.revision) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    let moduleUrl: string | undefined;
    try {
      const context = new AudioContext();
      this.context = context;
      moduleUrl = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
      await context.audioWorklet.addModule(moduleUrl);
      if (revision !== this.revision) return;
      await context.resume();
      if (revision !== this.revision) return;
      const framer = new Pcm16Framer(context.sampleRate);
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "companion-capture");
      const sink = context.createGain();
      sink.gain.value = 0;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        for (const frame of framer.push(event.data)) onFrame(frame);
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      this.node = node;
    } catch (error) {
      if (revision !== this.revision) return;
      await this.release();
      throw error;
    } finally {
      if (moduleUrl) URL.revokeObjectURL(moduleUrl);
    }
  }

  async stop() {
    this.revision += 1;
    await this.release();
  }

  private async release() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }
}
