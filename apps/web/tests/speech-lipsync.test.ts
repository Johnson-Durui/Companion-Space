import { afterEach, describe, expect, it, vi } from "vitest";
import { resampleBufferToPcm16_24k, SpeechOutput } from "../src/audio/speech-output";

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connections: AudioNode[] = [];
  connect(node: AudioNode) {
    this.connections.push(node);
    return node;
  }
  start() {}
  stop() {}
}

class Context {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = "running";
  sources: Source[] = [];
  createAnalyser() {
    return {
      connect() {},
      fftSize: 8,
      getFloatTimeDomainData(values: Float32Array) {
        values.fill(0.15);
      },
    } as unknown as AnalyserNode;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      sampleRate,
      getChannelData: () => channel,
      length,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  resume() {
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SpeechOutput audio level and 24kHz PCM chunk forwarding", () => {
  it("emits RMS audio levels and 24kHz mono PCM16 chunks for video avatar drivers", async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    const onLevel = vi.fn();
    const onSpeechChunk = vi.fn();
    const output = new SpeechOutput({ onLevel, onSpeechChunk });
    await output.prepare();
    output.setGeneration(1);

    const packet = new ArrayBuffer(20);
    new Uint8Array(packet).set(new TextEncoder().encode("CSA1"));
    const header = new DataView(packet);
    header.setUint32(4, 1);
    header.setUint32(8, 1);
    output.pushFrame(packet, { format: "pcm_s16le", sampleRate: 24000 });
    void output.play(1, 1).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    frame?.(0);

    expect(onSpeechChunk).toHaveBeenCalledOnce();
    expect(onSpeechChunk.mock.calls[0]?.[0]).toMatchObject({ gen: 1, seg: 1, sampleRate: 24000 });
    expect(onLevel).toHaveBeenCalled();
    await output.close();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });

  it("resamples 48kHz buffers down to 24kHz Int16 PCM cleanly", () => {
    const samples = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
    const buffer = {
      sampleRate: 48000,
      length: samples.length,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;
    const pcm = new Int16Array(resampleBufferToPcm16_24k(buffer));
    expect(pcm.length).toBe(4);
    expect(pcm[1]).toBeGreaterThan(10_000);
    expect(pcm[3]).toBeLessThan(-10_000);
  });
});
