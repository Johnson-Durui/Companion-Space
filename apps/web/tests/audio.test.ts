import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophoneCapture, Pcm16Framer } from "../src/audio/microphone";
import { CSA1_FLAG_LAST, OrderedGenerationQueue, parseCsa1Frame } from "../src/audio/protocol";
import { SpeechOutput } from "../src/audio/speech-output";

function csa1(gen: number, seg: number, flags: number, payload: number[]) {
  const data = new ArrayBuffer(16 + payload.length);
  const bytes = new Uint8Array(data);
  bytes.set(new TextEncoder().encode("CSA1"));
  bytes.set(payload, 16);
  const view = new DataView(data);
  view.setUint32(4, gen, false);
  view.setUint32(8, seg, false);
  view.setUint16(12, flags, false);
  return data;
}

class AudioSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect() {}
  start() {}
  stop() {}
  finish() { this.onended?.(); }
}

class TestAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = "running";
  sources: AudioSource[] = [];
  gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn> }> = [];
  analyserConnections: unknown[] = [];
  createAnalyser() {
    const analyserConnections = this.analyserConnections;
    return {
      connect(target: unknown) { analyserConnections.push(target); },
      fftSize: 8,
      getFloatTimeDomainData(values: Float32Array) { values.fill(0.25); },
    } as unknown as AnalyserNode;
  }
  createGain() {
    const node = { gain: { value: 1 }, connect: vi.fn() };
    this.gains.push(node);
    return node as unknown as GainNode;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => samples, length } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const source = new AudioSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  decodeAudioData() { return Promise.resolve(this.createBuffer(1, 24, 24000)); }
  close() { this.state = "closed"; return Promise.resolve(); }
  resume() { return Promise.resolve(); }
}

function audioBrowser() {
  const contexts: TestAudioContext[] = [];
  class Context extends TestAudioContext {
    constructor() { super(); contexts.push(this); }
  }
  class Utterance {
    lang = "";
    pitch = 1;
    rate = 1;
    volume = 1;
    voice: SpeechSynthesisVoice | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
    constructor(public text: string) {}
  }
  const spoken: Utterance[] = [];
  const speechSynthesis = {
    cancel() {},
    getVoices: () => [],
    speak(utterance: Utterance) { spoken.push(utterance); utterance.onstart?.(); },
  };
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("window", {
    clearTimeout,
    setTimeout(callback: () => void) { callback(); return 1; },
    speechSynthesis,
  });
  return { contexts, spoken };
}

afterEach(() => vi.unstubAllGlobals());

describe("M5 audio protocol", () => {
  it("parses the network-order CSA1 header without exposing it as audio", () => {
    const parsed = parseCsa1Frame(csa1(0x01020304, 7, CSA1_FLAG_LAST, [9, 8]));
    expect(parsed).toMatchObject({ gen: 0x01020304, seg: 7, flags: CSA1_FLAG_LAST });
    expect([...new Uint8Array(parsed.payload)]).toEqual([9, 8]);
  });

  it("streams the current segment and releases future segments in order", () => {
    const queue = new OrderedGenerationQueue<string>();
    queue.setGeneration(4);
    expect(queue.push(4, 2, "second", true)).toEqual([]);
    expect(queue.push(3, 1, "stale", true)).toEqual([]);
    expect(queue.push(4, 1, "first-a")).toEqual([{ seg: 1, value: "first-a", last: false }]);
    expect(queue.push(4, 1, "first-b", true)).toEqual([
      { seg: 1, value: "first-b", last: true },
      { seg: 2, value: "second", last: true },
    ]);
  });
});

describe("M5 microphone framing", () => {
  it("low-pass filters and emits exact 20 ms little-endian PCM frames", () => {
    const input = Float32Array.from({ length: 960 }, (_, index) => Math.sin(index / 12));
    const frames = new Pcm16Framer(48000).push(input);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.pcm16.byteLength).toBe(640);
    expect(frames[0]?.level).toBeGreaterThan(0);
  });

  it("releases a microphone permission that arrives after capture was stopped", async () => {
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => { grant = resolve; });
    const getUserMedia = vi.fn(() => permission);
    const trackStop = vi.fn();
    const frame = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const capture = new MicrophoneCapture();
    const started = capture.start(frame);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await capture.stop();
    grant({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await started;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(frame).not.toHaveBeenCalled();
  });
});

describe("SpeechOutput", () => {
  it("publishes analyser levels outside React state and resets after playback", async () => {
    const browser = audioBrowser();
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 7; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onLevel = vi.fn();
    const output = new SpeechOutput({ onLevel });
    output.setGeneration(8);
    output.pushFrame(csa1(8, 1, 0, [1, 0, 2, 0]), { format: "pcm_s16le", sampleRate: 24000 });
    const played = output.play(8, 1);
    output.finishSegment(8, 1);
    await Promise.resolve();
    await Promise.resolve();
    frame?.(0);
    expect(onLevel).toHaveBeenCalledWith(1);
    browser.contexts[0]?.sources[0]?.finish();
    await expect(played).resolves.toBeUndefined();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });

  it("waits for a separately signalled PCM segment to finish audibly", async () => {
    const browser = audioBrowser();
    const output = new SpeechOutput();
    output.setGeneration(8);
    output.pushFrame(csa1(8, 1, 0, [1, 0, 2, 0]), { format: "pcm_s16le", sampleRate: 24000 });
    const played = output.play(8, 1);
    output.finishSegment(8, 1);
    await Promise.resolve();
    await Promise.resolve();
    let complete = false;
    void played.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    browser.contexts[0]?.sources[0]?.finish();
    await expect(played).resolves.toBeUndefined();
  });

  it("skips browser audio in the binary order while waiting for browser speech", async () => {
    const browser = audioBrowser();
    const output = new SpeechOutput();
    output.setGeneration(2);
    output.pushFrame(csa1(2, 2, CSA1_FLAG_LAST, [1, 0]), { format: "pcm_s16le" });
    expect(output.skipSegment(2, 1)).toBe(true);
    const browserPlayed = output.useBrowser(2, 1, "hello");
    browser.spoken[0]?.onend?.();
    await expect(browserPlayed).resolves.toBeUndefined();
    const second = output.play(2, 2);
    await Promise.resolve();
    await Promise.resolve();
    browser.contexts[0]?.sources[0]?.finish();
    await expect(second).resolves.toBeUndefined();
  });

  it("cancels active audio and rejects stale frames when generation advances", async () => {
    audioBrowser();
    const output = new SpeechOutput();
    output.setGeneration(3);
    const active = output.useBrowser(3, 1, "old");
    output.setGeneration(4);
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(output.pushFrame(csa1(3, 1, CSA1_FLAG_LAST, [1, 0]), { format: "pcm_s16le" })).toBe(false);
  });

  it("places GainNode after AnalyserNode so avatar speech level stays active when muted", async () => {
    const browser = audioBrowser();
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 9; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onLevel = vi.fn();
    const output = new SpeechOutput({ onLevel });
    output.setVolume(0.4);
    output.setMuted(true);
    output.setGeneration(1);
    output.pushFrame(csa1(1, 1, CSA1_FLAG_LAST, [1, 0, 2, 0]), { format: "pcm_s16le", sampleRate: 24000 });
    const played = output.play(1, 1);
    await Promise.resolve();
    await Promise.resolve();
    const ctx = browser.contexts[0]!;
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.analyserConnections[0]).toBe(ctx.gains[0]);
    expect(ctx.gains[0]!.connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.gains[0]!.gain.value).toBe(0);
    frame?.(0);
    expect(onLevel).toHaveBeenCalledWith(1);
    output.setMuted(false);
    expect(ctx.gains[0]!.gain.value).toBe(0.4);
    ctx.sources[0]?.finish();
    await played;

    // Browser speech synthesis also honors volume and mute
    output.setVolume(0.35);
    const browserDone = output.useBrowser(1, 2, "hi");
    expect(browser.spoken[0]?.volume).toBe(0.35);
    browser.spoken[0]?.onend?.();
    await browserDone;

    output.setMuted(true);
    const mutedDone = output.useBrowser(1, 3, "quiet");
    expect(browser.spoken[1]?.volume).toBe(0);
    browser.spoken[1]?.onend?.();
    await mutedDone;
  });
});
