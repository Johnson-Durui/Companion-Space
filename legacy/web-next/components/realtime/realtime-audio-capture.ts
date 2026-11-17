import { Pcm16MonoFramer, measureLevel } from "@/components/realtime/realtime-audio";

export type RealtimeAudioFrameHandler = (level: number, pcm: Float32Array) => void;

function audioWorkletModuleSource() {
  return `
    class PulseProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        const quantum = 128;
        this.batchSamples = Math.max(quantum, Math.ceil(sampleRate * 0.02 / quantum) * quantum);
        this.pcm = new Float32Array(this.batchSamples);
        this.offset = 0;
        this.sum = 0;
      }
      process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel?.length) return true;
        for (let index = 0; index < channel.length; index += 1) {
          const sample = channel[index];
          this.sum += sample * sample;
          this.pcm[this.offset++] = sample;
          if (this.offset === this.batchSamples) {
            const pcm = this.pcm;
            const level = Math.sqrt(this.sum / this.batchSamples);
            this.pcm = new Float32Array(this.batchSamples);
            this.offset = 0;
            this.sum = 0;
            this.port.postMessage({ level, pcm }, [pcm.buffer]);
          }
        }
        return true;
      }
    }
    registerProcessor("pulse-processor", PulseProcessor);
  `;
}

export class RealtimeAudioCapture {
  private context: AudioContext | null = null;
  private framer: Pcm16MonoFramer | null = null;
  private generation = 0;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;

  frame(pcm: Float32Array) {
    return this.framer?.push(pcm) ?? [];
  }

  resetFrames() {
    this.framer?.reset();
  }

  async start(isCurrent: () => boolean, onFrame: RealtimeAudioFrameHandler) {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集；请改用文字模式。");
    }
    const generation = this.generation + 1;
    this.generation = generation;
    await this.release();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (generation !== this.generation || !isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Page lifecycle changed before microphone capture started.");
    }
    this.stream = stream;
    const context = new window.AudioContext();
    this.context = context;
    try {
      await context.resume();
      if (generation !== this.generation || !isCurrent()) {
        throw new Error("Page lifecycle changed while microphone capture was starting.");
      }
      if (context.state !== "running") {
        throw new Error("麦克风音频上下文未启动；请再点击一次开启实时。");
      }
      this.framer = new Pcm16MonoFramer(context.sampleRate);
      const source = context.createMediaStreamSource(stream);
      if (typeof AudioWorkletNode !== "undefined" && context.audioWorklet) {
        const moduleUrl = URL.createObjectURL(new Blob([audioWorkletModuleSource()], {
          type: "application/javascript",
        }));
        try {
          await context.audioWorklet.addModule(moduleUrl);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }
        const node = new AudioWorkletNode(context, "pulse-processor");
        node.port.onmessage = (event: MessageEvent<{ level: number; pcm: Float32Array }>) => {
          onFrame(event.data.level, event.data.pcm);
        };
        const sink = context.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
        this.node = node;
        return;
      }
      const fallback = context.createScriptProcessor(1024, 1, 1);
      fallback.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        onFrame(measureLevel(channel), new Float32Array(channel));
      };
      source.connect(fallback);
      fallback.connect(context.destination);
      this.node = fallback;
    } catch (error) {
      if (generation === this.generation) {
        await this.release();
      }
      throw error;
    }
  }

  async stop() {
    this.generation += 1;
    await this.release();
  }

  private async release() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.framer = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      await context.close();
    }
  }
}
