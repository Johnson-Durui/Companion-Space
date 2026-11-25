// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_CLIP_SLOTS } from "@companion-space/avatar-engine/catalog";
import { api, type Character } from "../src/app/api";
import type { LessonEvent } from "../src/features/classroom/timeline";
import { ReplayStage } from "../src/features/replay/replay-stage";
import { TutorShowcase } from "../src/features/tutors/tutor-showcase";
import { playBrowserSpeech, type SpeakResult } from "../src/features/voice/use-tutor-speech";
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

  it("TutorShowcase falls back to browser speechSynthesis when /voice/speak returns unavailable with text, keeping mouth closed until onstart", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    class ControlledUtterance {
      text: string;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    const spoken: ControlledUtterance[] = [];
    const cancel = vi.fn();
    const speak = vi.fn((u: ControlledUtterance) => {
      spoken.push(u);
    });
    vi.stubGlobal("SpeechSynthesisUtterance", ControlledUtterance);
    vi.stubGlobal("speechSynthesis", { speak, cancel });

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

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    await act(async () => {
      resolveSpeechHttp({
        kind: "unavailable",
        text: "先听清主旋律，再拆伴奏细节。",
        engine: "browser",
        reason_code: "browser_engine",
      });
      await Promise.resolve();
    });

    // Browser utterance queued, but utterance.onstart has NOT fired yet:
    // B13 lip-sync invariant: mouth MUST stay closed until onstart!
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.lang).toBe("zh-CN");
    expect(spoken[0]!.text).toBe("先听清主旋律，再拆伴奏细节。");
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");
    expect(host.textContent).not.toContain(t.speech.unavailable);

    // Audible browser speech starts -> switches to lecturing (explicit browser_engine is not a degraded fallback)
    await act(async () => {
      spoken[0]!.onstart?.();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("lecturing");
    expect(surface()?.getAttribute("data-clip")).toBe("speak_explain_a");
    expect(host.textContent).not.toContain(t.speech.unavailable);
    expect(host.textContent).not.toContain(t.speech.browserFallback);

    // Browser speech finishes -> exits lecturing and returns to idle_companion
    await act(async () => {
      spoken[0]!.onend?.();
      await Promise.resolve();
    });
    expect(videoBox()?.getAttribute("data-pose")).not.toBe("lecturing");

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(videoBox()?.getAttribute("data-pose")).toBe("idle_companion");
  });

  it("TutorShowcase shows visible browserFallback notice when server TTS degrades to browser speechSynthesis", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    class ControlledUtterance {
      text: string;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    const spoken: ControlledUtterance[] = [];
    vi.stubGlobal("SpeechSynthesisUtterance", ControlledUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: vi.fn((u: ControlledUtterance) => {
        spoken.push(u);
      }),
      cancel: vi.fn(),
    });

    vi.spyOn(api, "POST").mockResolvedValue({
      data: {
        kind: "unavailable",
        text: "先听清主旋律，再拆伴奏细节。",
        engine: "browser",
        warning: "Fixture online voice unavailable",
        reason_code: "tts_unavailable",
      },
      response: { ok: true, status: 200 },
    } as never);

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
    await act(async () => {
      previewBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spoken).toHaveLength(1);
    expect(host.querySelector('[data-testid="tutor-speech-status"]')).toBeNull();

    // Audible fallback begins -> honest degradation status is shown
    await act(async () => {
      spoken[0]!.onstart?.();
      await Promise.resolve();
    });
    const status = host.querySelector<HTMLElement>('[data-testid="tutor-speech-status"]');
    expect(status?.textContent).toBe(t.speech.browserFallback);
    expect(host.textContent).not.toContain(t.speech.unavailable);

    // Status remains visible after utterance completes so learner sees degradation honestly
    await act(async () => {
      spoken[0]!.onend?.();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="tutor-speech-status"]')?.textContent).toBe(t.speech.browserFallback);
  });

  it("TutorShowcase renders dynamic clip readiness from ACTIVE_CLIP_SLOTS without hardcoded 8/8", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    const total = ACTIVE_CLIP_SLOTS.length;
    const partialHost = mount(
      <MemoryRouter>
        <TutorShowcase character={sampleCharacter} isCurrent={false} onChoose={() => {}} />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const partialBadge = partialHost.querySelector('[data-testid="tutor-motion-badge"]')?.textContent;
    expect(partialBadge).toBe(
      t.richUi.tutorMotionReady.replace("{ready}", "8").replace("{total}", String(total)),
    );
    expect(partialBadge).not.toContain("8/8");

    const allClips: Record<string, string> = Object.fromEntries(
      ACTIVE_CLIP_SLOTS.map((slot) => [slot, `/clips/${slot}.webm`]),
    );
    const fullCharacter: Character = {
      ...sampleCharacter,
      video_avatar: {
        ...sampleCharacter.video_avatar!,
        loop_pack: {
          ...sampleCharacter.video_avatar!.loop_pack!,
          clips: allClips,
        },
      },
    };
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <TutorShowcase character={fullCharacter} isCurrent={false} onChoose={() => {}} />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    expect(partialHost.querySelector('[data-testid="tutor-motion-badge"]')?.textContent).toBe(
      t.richUi.tutorMotionReady.replace("{ready}", String(total)).replace("{total}", String(total)),
    );

    const customCharacter: Character = {
      ...sampleCharacter,
      video_avatar: {
        ...sampleCharacter.video_avatar!,
        loop_pack: {
          ...sampleCharacter.video_avatar!.loop_pack!,
          clips: {},
        },
      },
    };
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <TutorShowcase character={customCharacter} isCurrent={false} onChoose={() => {}} />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    expect(partialHost.querySelector('[data-testid="tutor-motion-badge"]')?.textContent).toBe(
      t.richUi.tutorCustomAvatar,
    );
  });

  it("TutorShowcase shows unavailable when browser speechSynthesis is missing or errors, and cleans up on cancel/unmount", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));

    class ControlledUtterance {
      text: string;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    // Case 1: browser TTS missing -> unavailable = true
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    vi.stubGlobal("speechSynthesis", undefined);
    vi.spyOn(api, "POST").mockResolvedValue({
      data: {
        kind: "unavailable",
        text: "先听清主旋律，再拆伴奏细节。",
        engine: "browser",
        reason_code: "tts_unavailable",
      },
      response: { ok: true, status: 200 },
    } as never);

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
    await act(async () => {
      previewBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain(t.speech.unavailable);
    expect(host.querySelector<HTMLElement>('[data-testid="tutor-video-box"]')?.getAttribute("data-pose")).not.toBe(
      "lecturing",
    );

    // Case 2: browser TTS errors -> unavailable = true
    const spoken: ControlledUtterance[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", ControlledUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: vi.fn((u: ControlledUtterance) => {
        spoken.push(u);
      }),
      cancel,
    });

    await act(async () => {
      previewBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spoken).toHaveLength(1);
    expect(host.textContent).not.toContain(t.speech.unavailable);

    await act(async () => {
      spoken[0]!.onerror?.({ error: "synthesis-failed" });
      await Promise.resolve();
    });
    expect(host.textContent).toContain(t.speech.unavailable);

    // Case 3: playBrowserSpeech cleanup cancels speechSynthesis and suppresses late callbacks
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const cleanup = playBrowserSpeech("测试朗读", { onStart, onEnd, onError });
    expect(spoken).toHaveLength(2);
    const activeUtterance = spoken[1]!;
    cleanup();
    expect(cancel).toHaveBeenCalled();
    expect(activeUtterance.onstart).toBeNull();
    expect(activeUtterance.onend).toBeNull();
    expect(activeUtterance.onerror).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
