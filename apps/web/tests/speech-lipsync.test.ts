import { afterEach, describe, expect, it, vi } from "vitest";

const { createAudioLipSync, dispose, lipInput } = vi.hoisted(() => {
  const input = {} as AudioNode;
  const disposeLipSync = vi.fn();
  return {
    lipInput: input,
    dispose: disposeLipSync,
    createAudioLipSync: vi.fn(async () => ({
      input,
      dispose: disposeLipSync,
      read: () => ({
        volume: 0.4,
        weights: { aa: 0.7, ih: 0.1, ou: 0, ee: 0.2, oh: 0 },
      }),
    })),
  };
});

vi.mock("@companion-space/avatar-engine/audio-lip-sync", () => ({ createAudioLipSync }));

import { SpeechOutput } from "../src/audio/speech-output";

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connections: AudioNode[] = [];
  connect(node: AudioNode) { this.connections.push(node); return node; }
  start() {}
  stop() {}
}

class Context {
  audioWorklet = {} as AudioWorklet;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = "running";
  sources: Source[] = [];
  createAnalyser() {
    return {
      connect() {},
      fftSize: 8,
      getFloatTimeDomainData(values: Float32Array) { values.fill(0.1); },
    } as unknown as AnalyserNode;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
      length,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  close() { this.state = "closed"; return Promise.resolve(); }
  resume() { return Promise.resolve(); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AudioContext lip sync", () => {
  it("routes decoded audio into wlipsync and publishes its measured visemes", async () => {
    let frame: FrameRequestCallback | undefined;
    const contexts: Context[] = [];
    vi.stubGlobal("AudioContext", class extends Context { constructor() { super(); contexts.push(this); } });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("window", { setTimeout: (callback: () => void) => { callback(); return 1; } });
    const onVisemes = vi.fn();
    const output = new SpeechOutput({ onVisemes });
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

    expect(createAudioLipSync).toHaveBeenCalledOnce();
    expect(contexts[0]?.sources[0]?.connections).toContain(lipInput);
    expect(onVisemes).toHaveBeenCalledWith({ aa: 0.7, ih: 0.1, ou: 0, ee: 0.2, oh: 0 });
    await output.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(onVisemes).toHaveBeenLastCalledWith(null);
  });

  it("keeps analyser playback available when AudioWorklet is unavailable", async () => {
    createAudioLipSync.mockRejectedValueOnce(new Error("AudioWorklet is unavailable."));
    vi.stubGlobal("AudioContext", class extends Context {
      audioWorklet = undefined as unknown as AudioWorklet;
    });
    vi.stubGlobal("isSecureContext", true);
    const onVisemes = vi.fn();
    const output = new SpeechOutput({ onVisemes });
    await expect(output.prepare()).resolves.toBeUndefined();
    expect(createAudioLipSync).toHaveBeenCalledOnce();
    await output.close();
    expect(onVisemes).toHaveBeenLastCalledWith(null);
  });
});
