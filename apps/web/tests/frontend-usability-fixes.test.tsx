// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, voiceStatusKey as apiVoiceStatusKey, type Character } from "../src/app/api";
import { RecapView } from "../src/features/classroom/recap-view";
import { useReadiness, voiceStatusKey as readinessVoiceStatusKey } from "../src/features/settings/use-readiness";
import { TutorVoiceSection } from "../src/features/settings/voice-settings";
import TutorDetailPage from "../src/features/tutors/tutor-detail";
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

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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
    preferred_tier: "static",
    anchor_image: "/static/avatars/portraits/lanyin.webp",
    loop_pack: { crossfade_ms: 180, clips: {} },
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
    traits: ["干练"],
    catchphrases: ["先听清主旋律。"],
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "companion_csrf=; Max-Age=0; path=/";
});

describe("Frontend usability bug fixes", () => {
  it("VoiceSettings sends default: null when saving a per-character override if no global default is set", async () => {
    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v2/voice/settings") {
        return Promise.resolve({
          data: { default: null, characters: {} },
          response: { ok: true, status: 200 },
        }) as never;
      }
      if (path === "/api/v2/characters") {
        return Promise.resolve({
          data: [sampleCharacter],
          response: { ok: true, status: 200 },
        }) as never;
      }
      if (path === "/api/v2/settings") {
        return Promise.resolve({
          data: { default_character_id: sampleCharacter.id },
          response: { ok: true, status: 200 },
        }) as never;
      }
      return Promise.resolve({ data: {}, response: { ok: true, status: 200 } }) as never;
    });

    const putSpy = vi.spyOn(api, "PUT").mockImplementation((_path: string, init?: { body?: unknown }) =>
      Promise.resolve({
        data: init?.body,
        response: { ok: true, status: 200 },
      }) as never,
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const host = mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/settings/tutor?teacher=tutor-lanyin"]}>
          <TutorVoiceSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();

    const saveBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button[type='submit']")).find((btn) =>
      btn.textContent?.includes(t.common.save),
    );
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn!.click();
    });
    await flush();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [calledPath, calledInit] = putSpy.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(calledPath).toBe("/api/v2/voice/settings");
    expect(calledInit.body.default).toBeNull();
    expect(calledInit.body.characters).toMatchObject({
      "tutor-lanyin": {
        engine: "edge",
        voice_id: "zh-CN-XiaoyiNeural",
      },
    });
  });

  it("TutorDetail persona save skips voice_settings sync when voice unchanged, and preserves custom TTS engine when voice changes", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const voiceSettingsState = {
      default: null,
      characters: {
        "tutor-lanyin": {
          engine: "openai_compat" as const,
          voice_id: "nova",
          model: "gpt-4o-mini-tts",
          rate: 1.0,
          pitch: 0,
          options: {},
        },
      },
    };

    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v2/characters") {
        return Promise.resolve({
          data: [sampleCharacter],
          response: { ok: true, status: 200 },
        }) as never;
      }
      if (path === "/api/v2/settings") {
        return Promise.resolve({
          data: { default_character_id: sampleCharacter.id },
          response: { ok: true, status: 200 },
        }) as never;
      }
      if (path === "/api/v2/voice/settings") {
        return Promise.resolve({
          data: voiceSettingsState,
          response: { ok: true, status: 200 },
        }) as never;
      }
      return Promise.resolve({ data: {}, response: { ok: true, status: 200 } }) as never;
    });

    const putCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(api, "PUT").mockImplementation((path: string, init?: { body?: Record<string, unknown> }) => {
      putCalls.push({ path, body: (init?.body ?? {}) as Record<string, unknown> });
      if (path === "/api/v2/characters/{character_id}") {
        const body = init?.body as { voice?: { voice_id?: string; rate?: number } };
        return Promise.resolve({
          data: {
            ...sampleCharacter,
            voice: {
              ...sampleCharacter.voice,
              voice_id: body?.voice?.voice_id ?? sampleCharacter.voice.voice_id,
              rate: body?.voice?.rate ?? sampleCharacter.voice.rate,
            },
          },
          response: { ok: true, status: 200 },
        }) as never;
      }
      return Promise.resolve({
        data: init?.body,
        response: { ok: true, status: 200 },
      }) as never;
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const host = mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tutors/tutor-lanyin?tab=persona"]}>
          <Routes>
            <Route path="/tutors/:tutorId" element={<TutorDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();

    // 1) Save persona WITHOUT changing voice fields -> must NOT touch /api/v2/voice/settings
    const form = host.querySelector<HTMLFormElement>('[data-testid="tutor-persona-form"]');
    expect(form).not.toBeNull();
    const saveBtn = form!.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(saveBtn).not.toBeNull();

    await act(async () => {
      saveBtn!.click();
    });
    await flush();

    expect(putCalls.map((c) => c.path)).toEqual(["/api/v2/characters/{character_id}"]);

    // 2) Change voice rate slider -> saves character AND syncs voice_settings while preserving openai_compat + "nova" + default: null
    const rateSlider = form!.querySelector<HTMLInputElement>('input[type="range"]');
    expect(rateSlider).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(rateSlider, "120");
      rateSlider!.dispatchEvent(new Event("input", { bubbles: true }));
      rateSlider!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      saveBtn!.click();
    });
    await flush();

    const voicePut = putCalls.find((c) => c.path === "/api/v2/voice/settings");
    expect(voicePut).toBeDefined();
    expect(voicePut!.body.default).toBeNull();
    expect((voicePut!.body.characters as Record<string, Record<string, unknown>>)["tutor-lanyin"]).toMatchObject({
      engine: "openai_compat",
      voice_id: "nova",
      model: "gpt-4o-mini-tts",
      rate: 1.2,
    });
  });

  it("RecapView abandoned resume button calls POST /api/v2/lessons/{id}/resume, invokes onResumed on success, and renders error on failure", async () => {
    document.cookie = "companion_csrf=csrf-test-token; path=/";
    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v2/lessons/{lesson_id}/recap-summary") {
        return Promise.resolve({
          data: {
            abandoned: true,
            summary: "",
            finished_at: "2026-11-24T12:00:00Z",
            stats: {
              active_ms: 60_000,
              keypoints_done: 1,
              keypoints_total: 3,
              correct_count: 0,
              correct_with_hint_count: 0,
              revealed_count: 0,
              style_switches: 0,
              backfill_count: 0,
            },
            mastery_changes: [],
            plan_change: null,
            next: null,
            review_cards_created: 0,
          },
          response: { ok: true, status: 200 },
        }) as never;
      }
      return Promise.resolve({ data: {}, response: { ok: true, status: 200 } }) as never;
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code: "lesson_not_found", message: "Not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "lesson-1", status: "paused" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const onResumed = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const host = mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/lessons/lesson-1"]}>
          <RecapView
            lessonId="lesson-1"
            courseId="course-1"
            title="极限与连续"
            board={[]}
            onResumed={onResumed}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();

    const resumeBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
      btn.textContent?.includes(t.recapView.resumeThis),
    );
    expect(resumeBtn).toBeDefined();

    // First click fails with 404 lesson_not_found -> shows localized error alert, does NOT call onResumed
    await act(async () => {
      resumeBtn!.click();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe("/api/v2/lessons/lesson-1/resume");
    expect(firstInit.method).toBe("POST");
    expect((firstInit.headers as Headers).get("X-CSRF-Token")).toBe("csrf-test-token");
    expect(onResumed).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.errors.lesson_not_found);

    // Second click succeeds -> calls onResumed
    await act(async () => {
      resumeBtn!.click();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onResumed).toHaveBeenCalledTimes(1);
  });

  it("Unifies voiceStatusKey between app/api.ts and use-readiness.ts so invalidation refreshes useReadiness", async () => {
    expect(apiVoiceStatusKey).toBe(readinessVoiceStatusKey);
    expect(apiVoiceStatusKey).toEqual(["voice-status"]);

    let sttReady = false;
    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v2/settings/model-roles") {
        return Promise.resolve({
          data: { live: { connection_id: "c1", model: "m1" }, analysis: { connection_id: "c1", model: "m1" } },
          response: { ok: true, status: 200 },
        }) as never;
      }
      if (path === "/api/v2/voice/status") {
        return Promise.resolve({
          data: { stt_configured: sttReady, tts_configured: true, input_modes: ["push_to_talk"], sample_rate_hz: 16000 },
          response: { ok: true, status: 200 },
        }) as never;
      }
      return Promise.resolve({ data: {}, response: { ok: true, status: 200 } }) as never;
    });

    function Probe() {
      const readiness = useReadiness(true);
      return <span data-testid="can-use-voice">{String(readiness.canUseVoice)}</span>;
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const host = mount(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await flush();

    expect(host.querySelector('[data-testid="can-use-voice"]')?.textContent).toBe("false");

    sttReady = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: apiVoiceStatusKey });
    });
    await flush();

    expect(host.querySelector('[data-testid="can-use-voice"]')?.textContent).toBe("true");
  });

  it("TutorDetail voice preview shows browserFallback notice and assets tab exports -video-prompts.md", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
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

    vi.spyOn(api, "GET").mockImplementation((path: string) => {
      if (path === "/api/v2/characters") {
        return Promise.resolve({ data: [sampleCharacter], response: { ok: true, status: 200 } }) as never;
      }
      if (path === "/api/v2/settings") {
        return Promise.resolve({ data: { default_character_id: sampleCharacter.id }, response: { ok: true, status: 200 } }) as never;
      }
      if (path === "/api/v2/voice/settings") {
        return Promise.resolve({ data: { default: null, characters: {} }, response: { ok: true, status: 200 } }) as never;
      }
      if (path === "/api/v2/avatar-drivers") {
        return Promise.resolve({ data: { local_sidecars: [] }, response: { ok: true, status: 200 } }) as never;
      }
      return Promise.resolve({ data: {}, response: { ok: true, status: 200 } }) as never;
    });
    vi.spyOn(api, "PUT").mockResolvedValue({ data: sampleCharacter, response: { ok: true, status: 200 } } as never);
    vi.spyOn(api, "POST").mockResolvedValue({
      data: {
        kind: "unavailable",
        text: sampleCharacter.greeting,
        engine: "browser",
        reason_code: "tts_unavailable",
      },
      response: { ok: true, status: 200 },
    } as never);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const host = mount(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tutors/tutor-lanyin?tab=persona"]}>
          <Routes>
            <Route path="/tutors/:tutorId" element={<TutorDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();

    const previewBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
      btn.textContent?.includes(t.tutorsGallery.voicePreview),
    );
    expect(previewBtn).toBeDefined();
    await act(async () => {
      previewBtn!.click();
    });
    await flush();
    expect(spoken).toHaveLength(1);

    await act(async () => {
      spoken[0]!.onstart?.();
    });
    expect(host.querySelector('[data-testid="tutor-speech-status"]')?.textContent).toBe(t.speech.browserFallback);

    // Verify prompt sheet export uses non-hardcoded -video-prompts.md filename
    const createdLinks: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreate(tagName, options);
      if (tagName.toLowerCase() === "a") {
        vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(() => {});
        createdLinks.push(el as HTMLAnchorElement);
      }
      return el;
    }) as typeof document.createElement);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prompt-sheet");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const assetsTab = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) =>
      el.textContent?.includes(t.tutorsGallery.tabs.assets),
    );
    expect(assetsTab).toBeDefined();
    await act(async () => {
      assetsTab!.click();
    });
    await flush();

    expect(host.querySelector('[data-testid="tutor-license-card"]')).toBeNull();

    const exportBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
      btn.textContent?.includes(t.characters.exportPrompts),
    );
    expect(exportBtn).toBeDefined();
    await act(async () => {
      exportBtn!.click();
    });
    expect(createdLinks.some((a) => a.download === `${sampleCharacter.id}-video-prompts.md`)).toBe(true);
  });
});
