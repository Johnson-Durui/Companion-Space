import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const vaultPassword = "m7-playwright-pass";

const defaultRecipe = {
  avatar_framing: "full_body",
  avatar_model: "mira_2d",
  stage_background: "neutral",
  base_model: "mini",
  face_style: "soft",
  hairstyle: "short_bob",
  outfit: "academy",
  accessories: [],
  palette: {
    skin_tone: "#f3d3c3",
    hair_color: "#5d718d",
    eye_color: "#9ed2ff",
    outfit_color: "#29354a",
    accent_color: "#77d7d1",
  },
  personality: "gentle",
  warmth: 72,
  initiative: 58,
  humor: 44,
  challenge: 34,
  relationship_role: "friend",
  voice_provider: "mock",
  voice_model: "mock-voice",
  voice_id: "default",
  speaking_rate: 1,
  motions: {
    idle: "/assets/characters/motions/companion-idle.vrma",
    listening: "/assets/characters/motions/companion-listening.vrma",
    thinking: "/assets/characters/motions/companion-thinking.vrma",
    speaking: "/assets/characters/motions/companion-speaking.vrma",
  },
};

test.use({ trace: "off", video: "off" });

test("drives the portrait through preview playback and restores the chosen state", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const ownerToken = await authorizeBrowser(page);
  const fixture = await createFixture(page.request, ownerToken, "mira_2d");
  await installAudioProbe(page);
  const pcm = makeSinePcm16(3);
  await page.route(`**/api/v1/characters/${fixture.characterId}/voice-preview`, async (route) => {
    await route.fulfill({
      body: pcm,
      contentType: "audio/pcm;rate=24000",
      headers: { "x-audio-sample-rate": "24000" },
    });
  });

  await page.goto(`/characters/${fixture.characterId}`);
  const runtime = page.locator('[data-avatar-runtime-kind="portrait_2d"]').first();
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle", { timeout: 20_000 });
  await page.getByRole("group", { name: "Preview State" }).getByRole("button", { name: "Listening" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "listening");

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(page.getByRole("status")).toContainText("正在试听，角色随声音同步。");
  await expect(runtime).toHaveAttribute("data-avatar-state", "speaking");
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-avatar-runtime-kind="portrait_2d"]');
    return Number.parseFloat(viewport?.style.getPropertyValue("--portrait-speech-level") || "0");
  })).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  await scrollRuntimeIntoEvidenceView(runtime);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("portrait-speaking.png"),
  });

  await expect(page.getByRole("status")).toContainText("试听已结束。", { timeout: 5_000 });
  await expect(runtime).toHaveAttribute("data-avatar-state", "listening");
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.lastLevel ?? -1)).toBe(0);
});

test("stops VRM playback immediately and returns to the selected state", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const ownerToken = await authorizeBrowser(page);
  const fixture = await createFixture(page.request, ownerToken, "vrm1_constraint_twist_sample");
  await installAudioProbe(page);
  await page.route(`**/api/v1/characters/${fixture.characterId}/voice-preview`, async (route) => {
    // This test clicks Stop after waiting for VRM mouth telemetry and capturing
    // evidence. Keep playback active so it exercises manual cancellation rather
    // than racing its natural drained callback on slower CI workers.
    await route.fulfill({
      body: makeSinePcm16(35),
      contentType: "audio/pcm;rate=24000",
      headers: { "x-audio-sample-rate": "24000" },
    });
  });

  await page.goto(`/characters/${fixture.characterId}`);
  const runtime = page.locator('[data-avatar-runtime-kind="vrm"]').first();
  await expect(runtime).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle");
  const canvas = runtime.locator("canvas[data-avatar-runtime-instance]");
  await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", /.+/);
  await page.getByRole("group", { name: "Preview State" }).getByRole("button", { name: "Thinking" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "speaking");
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  await expect.poll(async () => Number.parseFloat(
    (await canvas.getAttribute("data-avatar-mouth-weight")) ?? "0",
  )).toBeGreaterThan(0.01);
  await scrollRuntimeIntoEvidenceView(runtime);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("vrm-speaking.png"),
  });
  const previewStateButtons = page.getByRole("group", { name: "Preview State" }).getByRole("button");
  await expect(previewStateButtons.first()).toBeDisabled();

  await page.getByRole("button", { name: "停止试听" }).click();
  await expect(page.getByRole("status")).toContainText("试听已停止。");
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.stops ?? 0)).toBeGreaterThan(0);
  await expect.poll(async () => Number.parseFloat(
    (await canvas.getAttribute("data-avatar-mouth-weight")) ?? "-1",
  )).toBe(0);
  await expect(previewStateButtons.first()).toBeEnabled();
});

test("invalidates delayed previews for every voice input and lets the latest request win", async ({ page }) => {
  const ownerToken = await authorizeBrowser(page);
  const fixture = await createFixture(page.request, ownerToken, "mira_2d");
  await installAudioProbe(page);
  let requestCount = 0;
  let settledRequests = 0;
  const gates = [createGate(), createGate(), createGate()];
  await page.route(`**/api/v1/characters/${fixture.characterId}/voice-preview`, async (route) => {
    requestCount += 1;
    const gate = gates[requestCount - 1];
    await gate?.promise;
    try {
      await route.fulfill({
        body: makeSinePcm16(1.5),
        contentType: "audio/pcm;rate=24000",
        headers: { "x-audio-sample-rate": "24000" },
      });
    } catch (error) {
      rethrowUnexpectedRouteError(error);
    } finally {
      settledRequests += 1;
    }
  });

  await page.goto(`/characters/${fixture.characterId}`);
  const runtime = page.locator('[data-avatar-runtime-kind="portrait_2d"]').first();
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle", { timeout: 20_000 });
  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(page.getByRole("status")).toContainText("正在准备声音…");
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
  await page.getByLabel("Voice Preview", { exact: true }).fill("换一句新的试听台词。");
  await expect(page.getByRole("status")).toContainText("试听已停止。");
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle");
  gates[0]?.release();
  await expect.poll(() => settledRequests).toBe(1);

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
  await page.getByLabel("Voice ID", { exact: true }).fill("alternate");
  await expect(page.getByRole("status")).toContainText("试听已停止。");
  gates[1]?.release();
  await expect.poll(() => settledRequests).toBe(2);

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
  await page.getByLabel(/^Voice Rate/).press("ArrowRight");
  await expect(page.getByRole("status")).toContainText("试听已停止。");
  expect(await page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(0);

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "speaking");
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  gates[2]?.release();
  await expect.poll(() => settledRequests).toBe(4);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  await expect(page.getByRole("status")).toContainText("试听已结束。", { timeout: 5_000 });
  expect(requestCount).toBe(4);
});

test("cancels playback on space changes and prevents late audio after navigation", async ({ page }) => {
  const ownerToken = await authorizeBrowser(page);
  const fixture = await createFixture(page.request, ownerToken, "mira_2d");
  const alternateSpace = await createTtsSpace(page.request, ownerToken, "Alternate preview");
  await installAudioProbe(page);
  let requestCount = 0;
  let settledRequests = 0;
  const lateResponseGate = createGate();
  await page.route(`**/api/v1/characters/${fixture.characterId}/voice-preview`, async (route) => {
    requestCount += 1;
    if (requestCount === 2) {
      await lateResponseGate.promise;
    }
    try {
      await route.fulfill({
        body: makeSinePcm16(requestCount === 1 ? 4 : 0.5),
        contentType: "audio/pcm;rate=24000",
        headers: { "x-audio-sample-rate": "24000" },
      });
    } catch (error) {
      rethrowUnexpectedRouteError(error);
    } finally {
      settledRequests += 1;
    }
  });

  await page.goto(`/characters/${fixture.characterId}`);
  const runtime = page.locator('[data-avatar-runtime-kind="portrait_2d"]').first();
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle", { timeout: 20_000 });
  await page.getByRole("button", { name: "试听声音" }).click();
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  await page.getByLabel("TTS 试听学习空间").selectOption(alternateSpace.id as string);
  await expect(page.getByRole("status")).toContainText("试听已停止。");
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.stops ?? 0)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
  await Promise.all([
    page.waitForURL(/\/characters$/),
    page.locator('a[href="/characters"]').first().click(),
  ]);
  lateResponseGate.release();
  await expect.poll(() => settledRequests).toBe(2);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
});

test("surfaces a preview error and remains retryable", async ({ page }) => {
  const ownerToken = await authorizeBrowser(page);
  const fixture = await createFixture(page.request, ownerToken, "mira_2d");
  await installAudioProbe(page);
  let requestCount = 0;
  await page.route(`**/api/v1/characters/${fixture.characterId}/voice-preview`, async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 503, json: { detail: "试听服务暂时不可用" } });
      return;
    }
    await route.fulfill({
      body: makeSinePcm16(0.4),
      contentType: "audio/pcm;rate=24000",
      headers: { "x-audio-sample-rate": "24000" },
    });
  });

  await page.goto(`/characters/${fixture.characterId}`);
  const runtime = page.locator('[data-avatar-runtime-kind="portrait_2d"]').first();
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle", { timeout: 20_000 });
  await page.getByRole("button", { name: "试听声音" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "试听服务暂时不可用" })).toBeVisible();
  await expect(runtime).toHaveAttribute("data-avatar-state", "idle");
  await expect(page.getByRole("button", { name: "试听声音" })).toBeEnabled();

  await page.getByRole("button", { name: "试听声音" }).click();
  await expect.poll(() => page.evaluate(() => window.__voicePreviewProbe?.starts ?? 0)).toBe(1);
  await expect(page.getByRole("status")).toContainText("试听已结束。", { timeout: 5_000 });
});

declare global {
  interface Window {
    __voicePreviewProbe?: { starts: number; stops: number; lastLevel: number };
  }
}

async function installAudioProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { starts: 0, stops: 0, lastLevel: 0 };
    const AudioContextConstructor = window.AudioContext;
    if (AudioContextConstructor) {
      const original = AudioContextConstructor.prototype.createBufferSource;
      AudioContextConstructor.prototype.createBufferSource = function createBufferSource() {
        const source = original.call(this);
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        source.start = (...args: Parameters<AudioBufferSourceNode["start"]>) => {
          probe.starts += 1;
          return start(...args);
        };
        source.stop = (...args: Parameters<AudioBufferSourceNode["stop"]>) => {
          probe.stops += 1;
          return stop(...args);
        };
        return source;
      };
    }
    Object.assign(window, { __voicePreviewProbe: probe });
    const observer = new MutationObserver(() => {
      const viewport = document.querySelector<HTMLElement>('[data-avatar-runtime-kind="portrait_2d"]');
      probe.lastLevel = Number.parseFloat(
        viewport?.style.getPropertyValue("--portrait-speech-level") || "0",
      );
    });
    observer.observe(document.documentElement, { attributes: true, subtree: true });
  });
}

function makeSinePcm16(durationSeconds: number) {
  const samples = Math.floor(24_000 * durationSeconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * index) / 24_000) * 12_000);
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

async function scrollRuntimeIntoEvidenceView(runtime: ReturnType<Page["locator"]>) {
  await runtime.evaluate((element) => {
    const top = element.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ behavior: "instant", top: Math.max(0, top - 100) });
  });
}

function createGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function rethrowUnexpectedRouteError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(route|request|target|page|context).*(abort|cancel|close|dispose|handled)/i.test(message)) {
    throw error;
  }
}

async function authorizeBrowser(page: Page) {
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.ok()).toBeTruthy();
  const status = await statusResponse.json() as { initialized: boolean };
  const response = await page.request.post(
    `${apiBaseUrl}/api/v1/vault/${status.initialized ? "unlock" : "init"}`,
    { data: { password: vaultPassword } },
  );
  expect(response.ok()).toBeTruthy();
  const ownerToken = (await response.json() as { owner_token?: string }).owner_token;
  expect(ownerToken).toBeTruthy();
  await page.route("**/api/v1/**", async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), Authorization: `Bearer ${ownerToken}` },
    });
  });
  return ownerToken as string;
}

async function createFixture(
  request: APIRequestContext,
  ownerToken: string,
  avatarModel: string,
) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const space = await postJson(request, "/api/v1/spaces", ownerToken, {
    name: `Voice preview ${suffix}`,
    topic: "角色语音试听",
    goal: "验证形象、状态和声音同步",
  });
  const character = await postJson(request, "/api/v1/characters", ownerToken, {
    name: `Voice companion ${suffix}`,
    description: "E2E character voice preview",
    recipe: { ...defaultRecipe, avatar_model: avatarModel },
  });
  await putJson(request, `/api/v1/spaces/${space.id}/default-character`, ownerToken, {
    character_pack_id: character.id,
  });
  await postJson(request, `/api/v1/spaces/${space.id}/assignments`, ownerToken, {
    capability: "tts",
    provider_connection_id: "builtin-mock",
    model_name: "mock-voice-v1",
  });
  return { characterId: character.id as string, spaceId: space.id as string };
}

async function createTtsSpace(
  request: APIRequestContext,
  ownerToken: string,
  prefix: string,
) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const space = await postJson(request, "/api/v1/spaces", ownerToken, {
    name: `${prefix} ${suffix}`,
    topic: "角色语音试听",
    goal: "验证试听空间切换取消播放",
  });
  await postJson(request, `/api/v1/spaces/${space.id}/assignments`, ownerToken, {
    capability: "tts",
    provider_connection_id: "builtin-mock",
    model_name: "mock-voice-v1",
  });
  return space;
}

async function postJson(
  request: APIRequestContext,
  path: string,
  ownerToken: string,
  data: unknown,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${apiBaseUrl}${path}`, {
    data,
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function putJson(
  request: APIRequestContext,
  path: string,
  ownerToken: string,
  data: unknown,
) {
  const response = await request.put(`${apiBaseUrl}${path}`, {
    data,
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.ok()).toBeTruthy();
}
