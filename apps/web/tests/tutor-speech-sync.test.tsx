// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Character } from "../src/app/api";
import type { LessonEvent } from "../src/features/classroom/timeline";
import { ReplayStage } from "../src/features/replay/replay-stage";
import { TutorShowcase } from "../src/features/tutors/tutor-showcase";
import type { SpeakResult } from "../src/features/voice/use-tutor-speech";
import t from "../src/locales/zh-CN.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

class DeferredAudio {
  static instances: DeferredAudio[] = [];
  src = "";
  playbackRate = 1;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private resolvePlay!: () => void;
  private rejectPlay!: (err: Error) => void;

  constructor(src = "") {
    this.src = src;
    DeferredAudio.instances.push(this);
  }

  play() {
    return new Promise<void>((resolve, reject) => {
      this.resolvePlay = resolve;
      this.rejectPlay = reject;
    });
  }

  pause() {}

  startAudiblePlayback() {
    this.onplaying?.();
    this.resolvePlay?.();
  }

  finishAudiblePlayback() {
    this.onended?.();
  }

  failAudiblePlayback() {
    this.onerror?.();
    this.rejectPlay?.(new Error("Audio playback failed"));
  }
}

const sampleCharacter: Character = {
  id: "tutor-lanyin",
  name: "澜音",
  schema_version: 3,
  appearance: {
    kind: "video_pack",
    src: "/static/avatars/portraits/lanyin.webp",
    framing: {},
  },
  video_avatar: {
    aspect_ratio: "9:16",
    preferred_tier: "loop_pack",
    anchor_image: "/static/avatars/portraits/lanyin.webp",
    loop_pack: {
      crossfade_ms: 180,
      clips: {
        idle_breathe: "/clips/idle.webm",
        listen_nod: "/clips/listen.webm",
        think_chin: "/clips/think.webm",
        speak_explain_a: "/clips/speak_a.webm",
        speak_explain_b: "/clips/speak_b.webm",
        board_point: "/clips/point.webm",
        react_praise: "/clips/praise.webm",
        react_comfort: "/clips/comfort.webm",
      },
    },
    local_sidecar: { driver_id: null, fps: 25, resolution: "512x896" },
    cloud_live: {
      connection_id: null,
      model: null,
      idle_suspend_sec: 30,
      max_session_minutes: 10,
      max_session_cost_cny: 20,
      action_prompts: {},
    },
  },
  voice: {
    engine: "edge",
    voice_id: "zh-CN-XiaoyiNeural",
    rate: 1.0,
    pitch: 0,
  },
  persona: {
    relationship: "敏锐果断的声音设计师导师",
    traits: ["干练", "节奏感强"],
    catchphrases: ["先听清主旋律，再拆伴奏细节。"],
    address_user_as: "你",
  },
  default_style_id: "direct",
  theme: "lanyin",
  tagline: "干练锐利",
  greeting: "准备好抓核心了吗？",
  lines: {},
  license: "Apache-2.0",
  pack_metadata: {
    author: "Companion Space",
    terms: "Apache-2.0",
    license_url: null,
    allow_redistribution: true,
    source_kind: "builtin",
  },
};

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  DeferredAudio.instances = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Tutor lip-sync vs audible speech synchronization", () => {
  it("TutorShowcase keeps mouth closed during TTS synthesis and animates speaking only during audible playback", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", DeferredAudio);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    let resolveSpeechHttp!: (res: SpeakResult) => void;
    vi.spyOn(api, "POST").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpeechHttp = (data) =>
            resolve({ data, response: { ok: true, status: 200 } } as never);
        }) as never,
    );

    const host = mount(
      <MemoryRouter>
        <TutorShowcase
          character={sampleCharacter}
          isCurrent={false}
          introSeq={1}
          onChoose={() => {}}
        />
      </MemoryRouter>,
    );

    const videoBox = () => host.querySelector<HTMLElement>('[data-testid="tutor-video-box"]');
    const surface = () => host.querySelector<HTMLElement>(".tvb-surface");

    // Advance 2.5 seconds while Edge TTS HTTP synthesis is still pending on the server:
    // Avatar MUST NOT enter greeting/lecturing or speak_explain_a/b before audio arrives!
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("greeting");
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");
    expect(surface()?.getAttribute("data-clip")).not.toBe("speak_explain_a");
    expect(surface()?.getAttribute("data-clip")).not.toBe("speak_explain_b");

    // HTTP synthesis returns MP3, but <audio>.play() has not started outputting sound yet:
    await act(async () => {
      resolveSpeechHttp({
        kind: "audio",
        text: "先听清主旋律，再拆伴奏细节。",
        engine: "edge",
        format: "mp3",
        audio_b64: "AAAA",
      });
      await Promise.resolve();
    });
    expect(DeferredAudio.instances).toHaveLength(1);
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");

    // Now browser <audio> begins audible playback -> avatar MUST switch to lecturing clip
    // and MUST remain in lecturing for the whole audio duration (not prematurely closing!).
    await act(async () => {
      DeferredAudio.instances[0]!.startAudiblePlayback();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("lecturing");
    expect(surface()?.getAttribute("data-clip")).toBe("speak_explain_a");

    // 2 seconds into audible playback, mouth MUST still be speaking (not prematurely closed by .finally())
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("lecturing");

    // Audio playback finishes -> transitions out of lecturing into reaction then idle_companion
    await act(async () => {
      DeferredAudio.instances[0]!.finishAudiblePlayback();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("idle_companion");
  });

  it("TutorShowcase quote preview button waits for audible start before opening mouth and closes on audio end", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Audio", DeferredAudio);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    let resolveSpeechHttp!: (res: SpeakResult) => void;
    vi.spyOn(api, "POST").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpeechHttp = (data) =>
            resolve({ data, response: { ok: true, status: 200 } } as never);
        }) as never,
    );

    const host = mount(
      <MemoryRouter>
        <TutorShowcase
          character={sampleCharacter}
          isCurrent={false}
          introSeq={0}
          onChoose={() => {}}
        />
      </MemoryRouter>,
    );

    const previewBtn = host.querySelector<HTMLButtonElement>(`button[aria-label="${t.voice.preview}"]`);
    expect(previewBtn).not.toBeNull();
    act(() => {
      previewBtn!.click();
    });

    // During 3s TTS synthesis latency, mouth must remain closed
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    const videoBox = () => host.querySelector<HTMLElement>('[data-testid="tutor-video-box"]');
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");

    await act(async () => {
      resolveSpeechHttp({
        kind: "audio",
        text: "先听清主旋律，再拆伴奏细节。",
        engine: "edge",
        format: "mp3",
        audio_b64: "AAAA",
      });
      await Promise.resolve();
    });
    expect(DeferredAudio.instances).toHaveLength(1);
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");

    // Audio starts -> lecturing
    await act(async () => {
      DeferredAudio.instances[0]!.startAudiblePlayback();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("lecturing");

    // Still playing after 1.5s -> stays lecturing
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("lecturing");

    // Audio ends -> returns to idle_companion
    await act(async () => {
      DeferredAudio.instances[0]!.finishAudiblePlayback();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("idle_companion");
  });

  it("ReplayStage does not animate speaking on a say event while TTS audio is still synthesizing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
    const events: LessonEvent[] = [
      { lesson_id: "sample-1", seq: 1, gen: 1, t_ms: 100, type: "beat.start", data: { move: "OPEN" } },
      { lesson_id: "sample-1", seq: 2, gen: 1, t_ms: 200, type: "say", data: { seg: 1, text: "先看定义。" } },
    ];

    const host = mount(
      <MemoryRouter>
        <ReplayStage
          title="示例课"
          backTo="/welcome"
          backLabel="返回"
          events={events}
          position={2}
          playing
          speed={1}
          speaking={false}
          teacher={sampleCharacter}
          onTogglePlay={() => {}}
          onSeekPosition={() => {}}
          onSpeedChange={() => {}}
        />
      </MemoryRouter>,
    );

    const videoBox = host.querySelector<HTMLElement>('[data-testid="tutor-video-box"]');
    expect(videoBox?.getAttribute("data-phase")).toBe("thinking");
    expect(videoBox?.getAttribute("data-pose")).toBe("thinking");

    act(() => {
      root!.render(
        <MemoryRouter>
          <ReplayStage
            title="示例课"
            backTo="/welcome"
            backLabel="返回"
            events={events}
            position={2}
            playing
            speed={1}
            speaking
            teacher={sampleCharacter}
            onTogglePlay={() => {}}
            onSeekPosition={() => {}}
            onSpeedChange={() => {}}
          />
        </MemoryRouter>,
      );
    });

    expect(videoBox?.getAttribute("data-phase")).toBe("speaking");
    expect(videoBox?.getAttribute("data-pose")).toBe("lecturing");
  });
});
