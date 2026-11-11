import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const vaultPassword = "m7-playwright-pass";

test.use({ trace: "off", video: "off" });

test("saves, reloads, and edits a dedicated voice connection without exposing a local API key", async ({ page }) => {
  const ownerToken = await authorizeBrowser(page);
  const connection = await saveLocalVoiceConnection(page);
  const voiceRegion = getVoiceRegion(page);

  await expect(voiceConnectionSelect(page)).toHaveValue(connection.id);
  await expect(voiceConnectionNameInput(page)).toHaveValue(connection.label);
  await expect(voiceBaseUrlInput(page)).toHaveValue(connection.baseUrl);
  await expect(voiceRegion.getByLabel("API Key", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(getVoiceRegion(page)).toBeVisible();
  const reloadedConnection = voiceConnectionSelect(page);
  await expect(reloadedConnection.locator(`option[value="${connection.id}"]`)).toHaveText(connection.label);
  await reloadedConnection.selectOption(connection.id);
  await expect(voiceConnectionNameInput(page)).toHaveValue(connection.label);
  await expect(voiceBaseUrlInput(page)).toHaveValue(connection.baseUrl);

  const persisted = await getJson(page.request, "/api/v1/providers/connections", ownerToken) as Array<{
    id: string;
    provider: string;
    base_url: string | null;
  }>;
  expect(persisted).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: connection.id, provider: "local-neural", base_url: connection.baseUrl }),
  ]));

  await selectVoiceConnectionByLabel(page, "Built-in Mock");
  await expect(voiceConnectionNameInput(page)).toBeDisabled();
  await expect(voiceBaseUrlInput(page)).toBeDisabled();
  await expect(getVoiceRegion(page).getByRole("button", { name: "保存语音连接" })).toHaveCount(0);
});

test("keeps the voice panel synchronized with generic provider edits and deletion", async ({ page }) => {
  await authorizeBrowser(page);
  const connection = await saveLocalVoiceConnection(page);
  const voiceRegion = getVoiceRegion(page);
  await voiceModelInput(page).fill("qwen3-tts-preserved");
  await voiceIdInput(page).fill("Vivian");
  await setRangeToOnePointOne(voiceRateInput(page));
  await voicePreviewTextInput(page).fill("跨面板编辑不应清空这些试听参数。");

  const originalCard = page.locator("article.info-card").filter({ hasText: connection.label });
  await originalCard.getByRole("button", { name: connection.label }).click();
  const genericForm = page.locator("form").filter({ has: page.getByRole("button", { name: "保存修改" }) });
  await expect(genericForm).toBeVisible();
  const updatedLabel = `${connection.label} updated`;
  const updatedBaseUrl = connection.baseUrl.replace(/:\d+$/, ":60999");
  await genericForm.getByLabel("连接名称", { exact: true }).fill(updatedLabel);
  await genericForm.getByRole("textbox", { name: /^Base URL/ }).fill(updatedBaseUrl);
  const updateResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/providers/connections/${connection.id}`),
  );
  await genericForm.getByRole("button", { name: "保存修改" }).click();
  expect((await updateResponsePromise).ok()).toBeTruthy();

  await expect(voiceConnectionSelect(page)).toHaveValue(connection.id);
  await expect(voiceConnectionNameInput(page)).toHaveValue(updatedLabel);
  await expect(voiceBaseUrlInput(page)).toHaveValue(updatedBaseUrl);
  await expect(voiceModelInput(page)).toHaveValue("qwen3-tts-preserved");
  await expect(voiceIdInput(page)).toHaveValue("Vivian");
  expect(Number(await voiceRateInput(page).inputValue())).toBe(1.1);
  await expect(voicePreviewTextInput(page)).toHaveValue("跨面板编辑不应清空这些试听参数。");

  const updatedCard = page.locator("article.info-card").filter({ hasText: updatedLabel });
  await updatedCard.getByRole("button", { name: updatedLabel }).click();
  await expect(genericForm).toBeVisible();
  const voiceUpdatedLabel = `${updatedLabel} voice`;
  const voiceUpdatedBaseUrl = updatedBaseUrl.replace(":60999", ":60888");
  await voiceConnectionNameInput(page).fill(voiceUpdatedLabel);
  await voiceBaseUrlInput(page).fill(voiceUpdatedBaseUrl);
  const voiceUpdateResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/providers/connections/${connection.id}`),
  );
  await voiceRegion.getByRole("button", { name: "保存语音连接" }).click();
  expect((await voiceUpdateResponsePromise).ok()).toBeTruthy();
  await expect(genericForm.getByLabel("连接名称", { exact: true })).toHaveValue(voiceUpdatedLabel);
  await expect(genericForm.getByRole("textbox", { name: /^Base URL/ })).toHaveValue(voiceUpdatedBaseUrl);

  const genericResavePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/providers/connections/${connection.id}`),
  );
  await genericForm.getByRole("button", { name: "保存修改" }).click();
  const genericResave = await genericResavePromise;
  expect(genericResave.ok()).toBeTruthy();
  expect(genericResave.request().postDataJSON()).toEqual(expect.objectContaining({
    base_url: voiceUpdatedBaseUrl,
    label: voiceUpdatedLabel,
  }));

  const voiceUpdatedCard = page.locator("article.info-card").filter({ hasText: voiceUpdatedLabel });
  const deleteResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "DELETE" && response.url().endsWith(`/api/v1/providers/connections/${connection.id}`),
  );
  await voiceUpdatedCard.getByRole("button", { name: "删除" }).click();
  expect((await deleteResponsePromise).ok()).toBeTruthy();
  await expect(voiceConnectionSelect(page)).toHaveValue("");
  await expect(voiceConnectionSelect(page).locator(`option[value="${connection.id}"]`)).toHaveCount(0);
});

test("previews PCM audio, cancels stale work, and remains retryable after an error", async ({ page }) => {
  await authorizeBrowser(page);
  const connection = await saveLocalVoiceConnection(page);
  await installAudioProbe(page);
  const voiceRegion = getVoiceRegion(page);
  await voiceModelInput(page).fill("qwen3-tts-e2e");
  await voiceIdInput(page).fill("Serena");
  await setRangeToOnePointOne(voiceRateInput(page));
  await voicePreviewTextInput(page).fill("把这一段作为语音接口试听文本。");
  await expect(voiceRegion.getByRole("button", { name: "读取模型列表" })).toBeEnabled();

  let requestCount = 0;
  let settledCount = 0;
  const gates = [createGate(), null, null, createGate(), null, createGate(), createGate()];
  const previewPayloads: Array<Record<string, unknown>> = [];
  await page.route(`**/api/v1/providers/connections/${connection.id}/speech-preview`, async (route) => {
    requestCount += 1;
    const thisRequest = requestCount;
    previewPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    const gate = gates[thisRequest - 1];
    await gate?.promise;
    try {
      if (thisRequest === 2) {
        await route.fulfill({ status: 503, json: { detail: "语音接口暂时不可用" } });
      } else {
        await route.fulfill({
          body: makeSinePcm16(thisRequest === 5 ? 0.45 : 3),
          contentType: "audio/pcm;rate=24000",
          headers: {
            "access-control-allow-origin": "http://127.0.0.1:3100",
            "access-control-expose-headers": "x-audio-sample-rate, x-audio-channels",
            "cache-control": "no-store",
            "x-audio-channels": "1",
            "x-audio-sample-rate": "24000",
          },
        });
      }
    } catch (error) {
      rethrowUnexpectedRouteError(error);
    } finally {
      settledCount += 1;
    }
  });

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("正在准备语音试听");
  await voiceRegion.getByRole("button", { name: "停止试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("试听已停止");
  gates[0]?.release();
  await expect.poll(() => settledCount).toBe(1);
  expect(await page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(0);

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("alert").filter({ hasText: "语音接口暂时不可用" })).toBeVisible();
  await expect(voiceRegion.getByRole("button", { name: "测试并试听" })).toBeEnabled();

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(1);
  await expect(voiceRegion.getByRole("status")).toContainText("正在试听");
  expect(previewPayloads[2]).toEqual({
    model: "qwen3-tts-e2e",
    speaking_rate: 1.1,
    text: "把这一段作为语音接口试听文本。",
    voice_id: "Serena",
  });
  await voiceRegion.getByRole("button", { name: "停止试听" }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceInterfaceProbe?.stops ?? 0)).toBeGreaterThan(0);

  const startsAfterManualStop = await page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0);
  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("正在准备语音试听");
  await voiceIdInput(page).fill("Vivian");
  await expect(voiceRegion.getByRole("status")).toContainText("试听已停止");
  gates[3]?.release();
  await expect.poll(() => settledCount).toBe(4);
  expect(await page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(startsAfterManualStop);

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(startsAfterManualStop + 1);
  await expect(voiceRegion.getByRole("status")).toContainText("试听已完成", { timeout: 5_000 });

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("正在准备语音试听");
  await selectVoiceConnectionByLabel(page, "Built-in Mock");
  await expect(voiceRegion.getByRole("button", { name: "测试并试听" })).toBeEnabled();
  gates[5]?.release();
  await expect.poll(() => settledCount).toBe(6);
  expect(await page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(startsAfterManualStop + 1);

  await voiceConnectionSelect(page).selectOption(connection.id);
  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("正在准备语音试听");
  await Promise.all([page.waitForURL(/\/spaces$/), page.locator('a[href="/spaces"]').first().click()]);
  gates[6]?.release();
  await expect.poll(() => settledCount).toBe(7);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(startsAfterManualStop + 1);
});

test("plays the real built-in Mock speech response across the API origin", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await authorizeBrowser(page);
  await page.goto("/providers");
  await installAudioProbe(page);
  const voiceRegion = getVoiceRegion(page);
  await expect(voiceRegion).toBeVisible();
  await selectVoiceConnectionByLabel(page, "Built-in Mock");
  await expect(voiceModelInput(page)).toHaveValue("mock-voice-v1");
  await expect(voiceIdInput(page)).toHaveValue("default");

  await voiceRegion.getByRole("button", { name: "测试并试听" }).click();
  await expect(voiceRegion.getByRole("status")).toContainText("正在播放 Mock 测试音", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__voiceInterfaceProbe?.starts ?? 0)).toBe(1);
  await voiceRegion.screenshot({ animations: "disabled", path: testInfo.outputPath("voice-interface-region-desktop-1440.png") });
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("voice-interface-desktop-1440.png") });
  await voiceRegion.getByRole("button", { name: "停止试听" }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceInterfaceProbe?.stops ?? 0)).toBeGreaterThan(0);
  await expect(voiceRegion.getByRole("status")).toContainText("试听已停止");
});

test("binds the chosen voice model only to the selected learning space", async ({ page }) => {
  const ownerToken = await authorizeBrowser(page);
  const targetSpace = await createSpace(page.request, ownerToken, "Target voice space");
  const untouchedSpace = await createSpace(page.request, ownerToken, "Untouched voice space");
  await postJson(page.request, `/api/v1/spaces/${untouchedSpace.id}/assignments`, ownerToken, {
    capability: "tts",
    model_name: "mock-voice-v1",
    provider_connection_id: "builtin-mock",
  });
  const connection = await saveLocalVoiceConnection(page);
  const voiceRegion = getVoiceRegion(page);
  await voiceModelInput(page).fill("qwen3-tts-space-bound");
  await voiceRegion.getByRole("combobox", { name: "绑定学习空间", exact: true }).selectOption(targetSpace.id);

  const bindResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/api/v1/spaces/${targetSpace.id}/assignments`),
  );
  await voiceRegion.getByRole("button", { name: "绑定到空间" }).click();
  const bindResponse = await bindResponsePromise;
  expect(bindResponse.ok()).toBeTruthy();
  expect(bindResponse.request().postDataJSON()).toEqual({
    capability: "tts",
    model_name: "qwen3-tts-space-bound",
    provider_connection_id: connection.id,
  });
  await expect(voiceRegion.getByRole("status")).toContainText("已绑定");
  await expect(voiceRegion.getByRole("link", { name: "设置角色声线" })).toHaveAttribute("href", /\/characters/);

  const targetDetail = await getJson(page.request, `/api/v1/spaces/${targetSpace.id}`, ownerToken) as {
    assignments: Array<Record<string, unknown>>;
  };
  expect(targetDetail.assignments).toEqual(expect.arrayContaining([
    expect.objectContaining({
      capability: "tts",
      model_name: "qwen3-tts-space-bound",
      provider_connection_id: connection.id,
    }),
  ]));
  const untouchedDetail = await getJson(page.request, `/api/v1/spaces/${untouchedSpace.id}`, ownerToken) as {
    assignments: Array<Record<string, unknown>>;
  };
  expect(untouchedDetail.assignments).toEqual(expect.arrayContaining([
    expect.objectContaining({ capability: "tts", model_name: "mock-voice-v1", provider_connection_id: "builtin-mock" }),
  ]));
  expect(untouchedDetail.assignments).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_connection_id: connection.id }),
  ]));
});

test("keeps the voice interface inside a 390px viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authorizeBrowser(page);
  await page.goto("/providers");
  const voiceRegion = getVoiceRegion(page);
  await expect(voiceRegion).toBeVisible();
  const protocolSelect = voiceRegion.getByRole("combobox", { name: "协议类型", exact: true });
  await expect(protocolSelect.locator('option[value="local-neural"]')).toHaveCount(1);
  await expect(protocolSelect).toHaveValue("local-neural");
  await expect(voiceRegion.getByRole("button", { name: "保存语音连接" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 390, scrollWidth: 390 });
  const bounds = await voiceRegion.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.evaluate(() => {
    const region = document.getElementById("voice-service");
    if (region) window.scrollTo({ behavior: "auto", top: window.scrollY + region.getBoundingClientRect().top });
  });
  await expect.poll(async () => Math.abs((await voiceRegion.boundingBox())?.y ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("voice-interface-viewport-mobile-390.png") });
  await voiceRegion.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("voice-interface-region-mobile-390.png"),
    style: 'nav[aria-label="主要导航"] { visibility: hidden !important; }',
  });
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("voice-interface-mobile-390.png") });
});

declare global {
  interface Window {
    __voiceInterfaceProbe?: { starts: number; stops: number };
  }
}

function getVoiceRegion(page: Page) {
  return page.getByRole("region", { name: "语音接口配置" });
}

function voiceConnectionSelect(page: Page) {
  return getVoiceRegion(page).getByRole("combobox", { name: "语音连接", exact: true });
}

function voiceConnectionNameInput(page: Page) {
  return getVoiceRegion(page).getByRole("textbox", { name: "连接名称", exact: true });
}

function voiceBaseUrlInput(page: Page) {
  return getVoiceRegion(page).getByRole("textbox", { name: /^接口地址（Base URL）/ });
}

function voiceModelInput(page: Page) {
  return getVoiceRegion(page).getByRole("combobox", { name: "语音模型", exact: true });
}

function voiceIdInput(page: Page) {
  return getVoiceRegion(page).getByLabel("声线 ID");
}

function voiceRateInput(page: Page) {
  return getVoiceRegion(page).getByRole("slider", { name: /^语速/ });
}

function voicePreviewTextInput(page: Page) {
  return getVoiceRegion(page).getByRole("textbox", { name: "试听文本", exact: true });
}

async function setRangeToOnePointOne(locator: Locator) {
  await locator.focus();
  await locator.press("ArrowRight");
  await locator.press("ArrowRight");
  expect(Number(await locator.inputValue())).toBe(1.1);
}

async function selectVoiceConnectionByLabel(page: Page, label: string) {
  const select = voiceConnectionSelect(page);
  await expect(select).toBeEnabled();
  const option = select.getByRole("option", { name: label, exact: true });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value).toBeTruthy();
  await select.selectOption({ label });
  await expect(select).toHaveValue(value!);
}

async function saveLocalVoiceConnection(page: Page) {
  await page.goto("/providers");
  const voiceRegion = getVoiceRegion(page);
  await expect(voiceRegion).toBeVisible();
  await voiceConnectionSelect(page).selectOption("");
  await voiceRegion.getByLabel("协议类型", { exact: true }).selectOption("local-neural");
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const label = `Local voice ${suffix}`;
  const port = 61_000 + Math.floor(Math.random() * 3_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  await voiceConnectionNameInput(page).fill(label);
  await voiceBaseUrlInput(page).fill(baseUrl);
  await expect(voiceRegion.getByLabel("API Key", { exact: true })).toHaveCount(0);

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/providers/connections"),
  );
  await voiceRegion.getByRole("button", { name: "保存语音连接" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ api_key: "", base_url: baseUrl, label, provider: "local-neural" });
  const payload = await response.json() as { id: string };
  await expect(voiceConnectionSelect(page)).toHaveValue(payload.id);
  return { baseUrl, id: payload.id, label };
}

async function authorizeBrowser(page: Page) {
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.ok()).toBeTruthy();
  const status = await statusResponse.json() as { initialized: boolean };
  const response = await page.request.post(`${apiBaseUrl}/api/v1/vault/${status.initialized ? "unlock" : "init"}`, {
    data: { password: vaultPassword },
  });
  expect(response.ok()).toBeTruthy();
  const ownerToken = (await response.json() as { owner_token?: string }).owner_token;
  expect(ownerToken).toBeTruthy();
  await page.route("**/api/v1/**", async (route) => {
    await route.continue({ headers: { ...route.request().headers(), Authorization: `Bearer ${ownerToken}` } });
  });
  return ownerToken as string;
}

async function installAudioProbe(page: Page) {
  await page.evaluate(() => {
    const probe = { starts: 0, stops: 0 };
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
    Object.assign(window, { __voiceInterfaceProbe: probe });
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

async function createSpace(request: APIRequestContext, ownerToken: string, prefix: string) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return postJson(request, "/api/v1/spaces", ownerToken, {
    goal: "验证语音接口只绑定所选空间",
    name: `${prefix} ${suffix}`,
    topic: "语音接口绑定",
  }) as Promise<{ id: string }>;
}

async function postJson(request: APIRequestContext, path: string, ownerToken: string, data: unknown) {
  const response = await request.post(`${apiBaseUrl}${path}`, {
    data,
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function getJson(request: APIRequestContext, path: string, ownerToken: string) {
  const response = await request.get(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
