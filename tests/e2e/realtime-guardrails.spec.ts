import { readFileSync } from "node:fs";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const vaultPassword = "m7-playwright-pass";
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const firstPlaybackLatencyBudgetMs = 800;

test.use({ trace: "off", video: "off" });

type RealtimeFixture = {
  callPath: string;
  characterId: string;
  spaceId: string;
  spaceName: string;
};

function disableWebGL() {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement, contextId: string, options?: unknown) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(contextId)) {
        return null;
      }
      return Reflect.apply(originalGetContext, this, [contextId, options]);
    },
  });
}

const defaultRecipe = {
  avatar_framing: "full_body",
  avatar_model: "vrm1_constraint_twist_sample",
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

async function moveMouseWithinVisibleRuntime(
  page: Page,
  runtime: Locator,
  xRatio: number,
  yRatio: number,
) {
  const bounds = await runtime.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  const visibleLeft = Math.max(0, bounds!.x);
  const visibleRight = Math.min(viewport!.width, bounds!.x + bounds!.width);
  const visibleTop = Math.max(0, bounds!.y);
  const visibleBottom = Math.min(viewport!.height, bounds!.y + bounds!.height);
  expect(visibleRight - visibleLeft).toBeGreaterThan(2);
  expect(visibleBottom - visibleTop).toBeGreaterThan(2);
  const clampToVisibleArea = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum + 1), maximum - 1);
  await page.mouse.move(
    clampToVisibleArea(bounds!.x + bounds!.width * xRatio, visibleLeft, visibleRight),
    clampToVisibleArea(bounds!.y + bounds!.height * yRatio, visibleTop, visibleBottom),
  );
}

test.describe("realtime guardrails", () => {
  let ownerToken = "";

  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000);
    ownerToken = await initializeAndUnlockVault(page);
    await installFakeBuiltInVoices(page);
  });

  test("renders Mori as a responsive sprite runtime without WebGL", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });

    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="mori_2d"]').first();
    const sprite = page.getByTestId("mori-sprite");
    const spriteAssetUrl = new URL(
      "/assets/characters/pets/mori/spritesheet.webp",
      page.url(),
    ).toString();
    const spriteResponse = await page.request.get(spriteAssetUrl);
    expect(spriteResponse.status()).toBe(200);
    expect(spriteResponse.headers()["content-type"]).toContain("image/webp");
    const decodedSprite = await page.evaluate(async (assetUrl) => {
      const image = new Image();
      image.src = assetUrl;
      await image.decode();
      return { height: image.naturalHeight, width: image.naturalWidth };
    }, spriteAssetUrl);
    expect(decodedSprite).toEqual({ height: 2288, width: 1536 });

    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-runtime-canvas-count", "0");
    await expect(sprite).toBeVisible();
    await expect(sprite).toHaveAttribute("data-row", "0");
    await expect(sprite).toHaveAttribute("data-frame-count", "6");
    await expect(sprite).toHaveAttribute("data-expression", "calm");
    await expect(runtime).toHaveAttribute("data-avatar-emotion", "neutral");
    await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
    await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);

    const bounds = await runtime.boundingBox();
    expect(bounds).not.toBeNull();
    await moveMouseWithinVisibleRuntime(page, runtime, 0.5, 0.01);
    await expect(sprite).toHaveAttribute("data-direction", "0");
    await expect(sprite).toHaveAttribute("data-row", "9");
    await expect(sprite).toHaveAttribute("data-frame", "0");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.99, 0.5);
    await expect(sprite).toHaveAttribute("data-direction", "4");
    await expect(sprite).toHaveAttribute("data-row", "9");
    await expect(sprite).toHaveAttribute("data-frame", "4");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.5, 0.99);
    await expect(sprite).toHaveAttribute("data-direction", "8");
    await expect(sprite).toHaveAttribute("data-row", "10");
    await expect(sprite).toHaveAttribute("data-frame", "0");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.01, 0.5);
    await expect(sprite).toHaveAttribute("data-direction", "12");
    await expect(sprite).toHaveAttribute("data-row", "10");
    await expect(sprite).toHaveAttribute("data-frame", "4");
    await expect(sprite).toHaveAttribute("data-frame-count", "1");

    await runtime.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
    await expect(sprite).toHaveAttribute("data-row", "4");
    await expect(sprite).toHaveAttribute("data-frame-count", "5");

    await page.mouse.move(0, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(runtime).toHaveAttribute("data-avatar-reduced-motion", "true");
    await expect(sprite).toHaveAttribute("data-frame", "0");
  });

  test("maps every Mori emotion without replacing its session state row", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });
    const probes = [
      ["neutral", "calm"],
      ["warm", "soft"],
      ["cheerful", "wave"],
      ["curious", "lift"],
      ["focused", "attentive"],
      ["playful", "bounce"],
      ["concerned", "failed"],
    ] as const;
    let releaseFirstResponse = () => {};
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    let markFirstRequestStarted = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    let responseIndex = 0;

    await page.addInitScript(disableWebGL);
    await page.route("**/api/v1/sessions/*/turns/stream", async (route) => {
      const probe = probes[responseIndex];
      expect(probe).toBeDefined();
      if (responseIndex === 0) {
        markFirstRequestStarted();
        await firstResponseGate;
      }
      const response = await route.fetch();
      let finalEventCount = 0;
      const body = (await response.text()).split("\n").map((line) => {
        if (!line.trim()) return line;
        const event = JSON.parse(line) as { type?: unknown; payload?: { emotion?: unknown } };
        if (event.type === "llm.final" && event.payload) {
          event.payload.emotion = probe![0];
          finalEventCount += 1;
          return JSON.stringify(event);
        }
        return line;
      }).join("\n");
      expect(finalEventCount).toBe(1);
      responseIndex += 1;
      await route.fulfill({ response, body });
    });
    await page.evaluate(disableWebGL);
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="mori_2d"]').first();
    const sprite = page.getByTestId("mori-sprite");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });

    for (const [index, [emotion, expression]] of probes.entries()) {
      await page.getByPlaceholder(/输入消息/).fill(`请用${emotion}情绪回应。`);
      await page.getByRole("button", { name: "发送文本" }).click();
      if (index === 0) {
        await firstRequestStarted;
        await expect(runtime).toHaveAttribute("data-avatar-state", "thinking");
        await expect(sprite).toHaveAttribute("data-row", "7");
        releaseFirstResponse();
      }
      await expect(runtime).toHaveAttribute("data-avatar-emotion", emotion, { timeout: 20_000 });
      await expect(runtime).toHaveAttribute("data-avatar-state", "idle");
      await expect(sprite).toHaveAttribute("data-expression", expression);
      await expect(sprite).toHaveAttribute("data-row", "0");
    }
    expect(responseIndex).toBe(probes.length);
  });

  test("keeps the mobile Mori composer above the task navigation", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="mori_2d"]').first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });
    const activeStudyTab = page.getByRole("navigation", { name: "主要导航" })
      .locator('.mobile-tab[aria-current="page"]');
    await expect(activeStudyTab).toContainText("共学");
    await expect(activeStudyTab).toHaveAttribute("href", fixture.callPath);
    await expect(page.getByRole("textbox", { name: "发送文字消息" })).toBeVisible();

    const layout = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="realtime-composer"]');
      const tabBar = document.querySelector<HTMLElement>(".mobile-tab-bar");
      if (!composer || !tabBar) {
        return null;
      }
      const composerBounds = composer.getBoundingClientRect();
      const tabBounds = tabBar.getBoundingClientRect();
      return {
        composerBottom: composerBounds.bottom,
        composerTop: composerBounds.top,
        tabTop: tabBounds.top,
        viewportHeight: window.innerHeight,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.composerBottom).toBeLessThanOrEqual(layout!.tabTop + 1);
    expect(layout!.composerTop).toBeGreaterThanOrEqual(0);
    expect(layout!.tabTop).toBeLessThan(layout!.viewportHeight);
  });

  test("keeps a mobile VRM face and primary voice controls visible", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: {
        ...defaultRecipe,
        avatar_framing: "full_body",
        avatar_model: "mira",
      },
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="vrm"]').first();
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-camera-composition", "conversation");
    await expect.poll(async () => Number(await canvas.getAttribute("data-camera-vertical-occupancy")))
      .toBeGreaterThanOrEqual(0.86);
    await expect.poll(async () => Number(await canvas.getAttribute("data-camera-head-occupancy")))
      .toBeGreaterThanOrEqual(0.12);

    const layout = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="realtime-composer"]');
      const start = document.querySelector<HTMLElement>('button[aria-label="开始语音"]');
      const pushToTalk = document.querySelector<HTMLElement>('button[aria-label="按住说话"]');
      const status = document.querySelector<HTMLElement>('[role="status"]');
      const runtimeElement = document.querySelector<HTMLElement>('[data-runtime-kind="vrm"]');
      if (!composer || !start || !pushToTalk || !status || !runtimeElement) {
        return null;
      }
      const bounds = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      };
      return {
        composer: bounds(composer),
        pushToTalk: bounds(pushToTalk),
        runtime: bounds(runtimeElement),
        start: bounds(start),
        status: bounds(status),
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.runtime.bottom).toBeLessThanOrEqual(layout!.status.top + 1);
    expect(layout!.status.bottom).toBeLessThanOrEqual(layout!.start.top + 1);
    expect(layout!.start.bottom).toBeLessThanOrEqual(layout!.composer.top + 1);
    expect(layout!.pushToTalk.bottom).toBeLessThanOrEqual(layout!.composer.top + 1);

    await expect.poll(async () => {
      const values = (await canvas.getAttribute("data-avatar-motion-bone-sample"))
        ?.split(",")
        .map(Number);
      if (!values || values.length < 20) {
        return 0;
      }
      return Math.min(Math.abs(values[14]), Math.abs(values[18]));
    }).toBeGreaterThan(0.4);
  });

  test("persists Mori through the character workshop and reports sprite readiness", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);

    const moriChoice = page.getByRole("button", { name: /Mori · Original 2D/ });
    await moriChoice.click();
    await expect(moriChoice).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Mori runtime ready", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/Mori sprite runtime is ready/)).toBeVisible();
    await expect(page.getByText(/selected built-in 2D avatar/)).toBeVisible();

    const saveResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().endsWith(`/api/v1/characters/${fixture.characterId}`),
    );
    await page.getByRole("button", { name: "保存角色" }).click();
    const saved = await saveResponsePromise;
    expect(saved.ok()).toBeTruthy();
    expect(((await saved.json()) as { recipe?: { avatar_model?: unknown } }).recipe?.avatar_model)
      .toBe("mori_2d");

    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);
    await expect(page.getByRole("button", { name: /Mori · Original 2D/ })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 20_000 },
    );
    await expect(page.getByText("Mori runtime ready", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("fails Mori closed when its sprite atlas cannot load", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });

    await page.route("**/assets/characters/pets/mori/spritesheet.webp", async (route) => {
      await route.fulfill({ status: 404, body: "missing" });
    });
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="mori_2d"]').first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-runtime-reason", "sprite_load_failed");
    await expect(runtime).toHaveAttribute("aria-disabled", "true");
    await expect(runtime).toHaveAttribute("tabindex", "-1");
    const failedGestureSequence = await runtime.getAttribute("data-avatar-gesture-sequence");
    await runtime.click({ force: true });
    expect(await runtime.getAttribute("data-avatar-gesture-sequence")).toBe(failedGestureSequence);
    await expect(runtime.getByRole("alert")).toContainText("Mori");
    await expect(page.getByTestId("mori-sprite")).toHaveCount(0);
    await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
    await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);
  });

  test("renders Yuzu through the shared sprite runtime without WebGL", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "yuzu_2d" },
    });

    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="yuzu_2d"]').first();
    const sprite = page.getByTestId("yuzu-sprite");
    const spriteAssetUrl = new URL(
      "/assets/characters/pets/yuzu/spritesheet.webp",
      page.url(),
    ).toString();
    const spriteResponse = await page.request.get(spriteAssetUrl);
    expect(spriteResponse.status()).toBe(200);
    expect(spriteResponse.headers()["content-type"]).toContain("image/webp");
    expect(await page.evaluate(async (assetUrl) => {
      const image = new Image();
      image.src = assetUrl;
      await image.decode();
      return { height: image.naturalHeight, width: image.naturalWidth };
    }, spriteAssetUrl)).toEqual({ height: 2288, width: 1536 });

    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-runtime-canvas-count", "0");
    await expect(sprite).toBeVisible();
    await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
    await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);

    const bounds = await runtime.boundingBox();
    expect(bounds).not.toBeNull();
    await moveMouseWithinVisibleRuntime(page, runtime, 0.5, 0.01);
    await expect(sprite).toHaveAttribute("data-direction", "0");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.99, 0.5);
    await expect(sprite).toHaveAttribute("data-direction", "4");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.5, 0.99);
    await expect(sprite).toHaveAttribute("data-direction", "8");
    await moveMouseWithinVisibleRuntime(page, runtime, 0.01, 0.5);
    await expect(sprite).toHaveAttribute("data-direction", "12");

    await runtime.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
    await expect(sprite).toHaveAttribute("data-row", "3");
    await expect(sprite).toHaveAttribute("data-frame-count", "4");

  });

  test("persists Yuzu through the character workshop and reports sprite readiness", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);

    const yuzuChoice = page.getByRole("button", { name: /Yuzu · Original 2D/ });
    await yuzuChoice.click();
    await expect(yuzuChoice).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Yuzu runtime ready", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const saveResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().endsWith(`/api/v1/characters/${fixture.characterId}`),
    );
    await page.getByRole("button", { name: "保存角色" }).click();
    const saved = await saveResponsePromise;
    expect(saved.ok()).toBeTruthy();
    expect(((await saved.json()) as { recipe?: { avatar_model?: unknown } }).recipe?.avatar_model)
      .toBe("yuzu_2d");

    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);
    await expect(page.getByRole("button", { name: /Yuzu · Original 2D/ })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 20_000 },
    );
    await expect(page.getByText("Yuzu runtime ready", { exact: true })).toBeVisible();
  });

  test("renders all four original companions through the shared portrait runtime", async ({ page }) => {
    const companions = [
      { modelId: "mira_2d", asset: "/assets/characters/art/roster/mira.png" },
      { modelId: "kite_2d", asset: "/assets/characters/art/roster/kite.png" },
      { modelId: "cael_2d", asset: "/assets/characters/art/roster/cael.png" },
      { modelId: "lyra_2d", asset: "/assets/characters/art/roster/lyra.png" },
    ] as const;

    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);

    for (const companion of companions) {
      const fixture = await createRealtimeFixture(page.request, ownerToken, {
        recipe: { ...defaultRecipe, avatar_model: companion.modelId },
      });
      await openCallPage(page, fixture);

      const runtime = page.locator(
        `[data-runtime-kind="portrait_2d"][data-runtime-instance="${companion.modelId}"]`,
      ).first();
      const portrait = runtime.getByTestId("companion-portrait");
      const portraitStage = runtime.locator(`[data-model-id="${companion.modelId}"]`);
      const assetUrl = new URL(companion.asset, page.url()).toString();
      const assetResponse = await page.request.get(assetUrl);
      expect(assetResponse.status()).toBe(200);
      expect(assetResponse.headers()["content-type"]).toContain("image/png");
      expect(await page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { height: image.naturalHeight, width: image.naturalWidth };
      }, assetUrl)).toEqual({ height: 1536, width: 1024 });

      await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });
      await expect(runtime).toHaveAttribute("data-runtime-canvas-count", "0");
      await expect(portrait).toBeVisible();
      await expect.poll(async () => new URL(
        (await portrait.getAttribute("src")) ?? "",
        page.url(),
      ).pathname).toBe(companion.asset);
      await expect(portraitStage).toHaveAttribute("data-state", "idle");
      await expect(portraitStage).toHaveAttribute("data-emotion", "neutral");
      await expect(portraitStage).toHaveAttribute("data-expression", "neutral");
      await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
      await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);

      const previousGestureSequence = Number(
        await runtime.getAttribute("data-avatar-gesture-sequence"),
      );
      const initialPortraitStage = await portraitStage.elementHandle();
      await runtime.click();
      await expect(runtime).toHaveAttribute(
        "data-avatar-gesture-sequence",
        String(previousGestureSequence + 1),
      );
      await expect(portraitStage).toHaveAttribute("data-gesture", "active");
      expect(await initialPortraitStage?.evaluate((node) => node.isConnected)).toBe(false);

      const firstGestureStage = await portraitStage.elementHandle();
      await runtime.click();
      await expect(runtime).toHaveAttribute(
        "data-avatar-gesture-sequence",
        String(previousGestureSequence + 2),
      );
      await expect(portraitStage).toHaveAttribute("data-gesture", "active");
      expect(await firstGestureStage?.evaluate((node) => node.isConnected)).toBe(false);

      if (companion.modelId === "mira_2d") {
        await portrait.evaluate((image) => image.dispatchEvent(new Event("error")));
        await expect(runtime).toHaveAttribute("data-runtime-mode", "error");
        await expect(runtime).toHaveAttribute("data-runtime-reason", "portrait_render_failed");
        await expect(page.getByTestId("companion-portrait")).toHaveCount(0);
      }
    }
  });

  test("persists all four primary companions as full-body VRMs", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });
    const requestedVrmPaths = new Set<string>();
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith(".vrm")) {
        requestedVrmPaths.add(pathname);
      }
    });
    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);

    const avatarChoiceGroup = page.getByRole("group", { name: "Built-in avatar" });
    const presets = [
      {
        asset: "/assets/characters/models/Mira.vrm",
        id: "memory-navigator",
        modelButton: /澄羽 · MIRA · painted-blender/,
        modelId: "mira",
        name: "澄羽",
      },
      {
        asset: "/assets/characters/models/Kite.vrm",
        id: "short-round-captain",
        modelButton: /曜柚 · KITE · painted-blender/,
        modelId: "kite",
        name: "曜柚",
      },
      {
        asset: "/assets/characters/models/Cael.vrm",
        id: "constraint-senior",
        modelButton: /凛序 · CAEL · painted-blender/,
        modelId: "cael",
        name: "凛序",
      },
      {
        asset: "/assets/characters/models/Lyra.vrm",
        id: "story-lantern",
        modelButton: /弦灯 · LYRA · painted-blender/,
        modelId: "lyra",
        name: "弦灯",
      },
    ] as const;
    for (const preset of presets) {
      const presetButton = page.getByTestId(`companion-preset-${preset.id}`);
      await presetButton.scrollIntoViewIfNeeded();
      await presetButton.click();
      await expect(page.getByLabel("Name")).toHaveValue(preset.name);
      await expect(avatarChoiceGroup.getByRole("button", { name: preset.modelButton })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const runtime = page.locator('[data-runtime-kind="vrm"]').first();
      await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
      await expect(runtime).toHaveAttribute("data-avatar-framing", "full_body");
      const canvas = page.getByLabel("VRM character canvas").locator("canvas");
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "4");
      await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "4", {
        timeout: 60_000,
      });
      await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", /.+/);
      await expect.poll(() => requestedVrmPaths.has(preset.asset)).toBe(true);
      await expect(page.getByTestId("companion-portrait")).toHaveCount(0);
    }

    const miraChoice = page.getByTestId("companion-preset-memory-navigator");
    await miraChoice.click();
    await expect(page.getByLabel("Name")).toHaveValue("澄羽");
    await expect(avatarChoiceGroup.getByRole("button", { name: /澄羽 · MIRA · painted-blender/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("Runtime inspected", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/4 \/ 4 ready.*4 configured.*ready/)).toBeVisible();

    const saveResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().endsWith(`/api/v1/characters/${fixture.characterId}`),
    );
    await page.getByRole("button", { name: "保存角色" }).click();
    const saved = await saveResponsePromise;
    expect(saved.ok()).toBeTruthy();
    const savedCharacter = await saved.json() as {
      recipe?: { avatar_framing?: unknown; avatar_model?: unknown };
    };
    expect(savedCharacter.recipe?.avatar_model).toBe("mira");
    expect(savedCharacter.recipe?.avatar_framing).toBe("full_body");

    await Promise.all([
      page.waitForURL(/\/characters$/),
      page.getByRole("link", { name: "角色工作室", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`)),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);
    await expect(page.getByRole("group", { name: "Built-in avatar" })
      .getByRole("button", { name: /澄羽 · MIRA · painted-blender/ })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 60_000 },
    );
    await expect(page.getByLabel("VRM character canvas")).toBeVisible();
    await expect(page.getByText(/4 \/ 4 ready.*4 configured.*ready/)).toBeVisible({
      timeout: 60_000,
    });
  });

  test("fails an original portrait closed when its image cannot load", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mira_2d" },
    });
    await page.route("**/assets/characters/art/roster/mira.png", async (route) => {
      await route.fulfill({ status: 404, body: "missing" });
    });
    await openCallPage(page, fixture);

    const runtime = page.locator(
      '[data-runtime-kind="portrait_2d"][data-runtime-instance="mira_2d"]',
    ).first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-runtime-reason", "portrait_render_failed");
    await expect(runtime).toHaveAttribute("aria-disabled", "true");
    await expect(runtime).toHaveAttribute("tabindex", "-1");
    const failedGestureSequence = await runtime.getAttribute("data-avatar-gesture-sequence");
    await runtime.click({ force: true });
    expect(await runtime.getAttribute("data-avatar-gesture-sequence")).toBe(failedGestureSequence);
    await expect(runtime.getByRole("alert")).toContainText("澄羽 · MIRA");
    await expect(page.getByTestId("companion-portrait")).toHaveCount(0);
    await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
    await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);
  });

  test("fails an unknown avatar model closed instead of impersonating a built-in VRM", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "missing_companion_2d" },
    });
    await openCallPage(page, fixture);

    const runtime = page.locator(
      '[data-runtime-kind="unsupported"][data-runtime-instance="missing_companion_2d"]',
    ).first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-runtime-reason", "unsupported_avatar_model");
    await expect(runtime).toHaveAttribute("aria-disabled", "true");
    await expect(runtime).toHaveAttribute("tabindex", "-1");
    await expect(runtime.getByRole("alert")).toContainText("missing_companion_2d");
    await expect(page.getByTestId("companion-portrait")).toHaveCount(0);
    await expect(page.getByLabel("VRM character canvas")).toHaveCount(0);
    await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);
  });

  test("keeps a static portrait gesture acknowledgement in reduced-motion mode", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mira_2d" },
    });
    await openCallPage(page, fixture);

    const runtime = page.locator(
      '[data-runtime-kind="portrait_2d"][data-runtime-instance="mira_2d"]',
    ).first();
    const portraitStage = runtime.locator('[data-model-id="mira_2d"]');
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });
    await expect(runtime).toHaveAttribute("data-avatar-reduced-motion", "true");
    await runtime.click();
    await expect(portraitStage).toHaveAttribute("data-gesture", "active");
    await expect.poll(() => runtime.getByTestId("portrait-state-cue").evaluate((node) =>
      getComputedStyle(node).opacity)).toBe("1");
    await expect.poll(() => runtime.getByTestId("companion-portrait").evaluate((node) =>
      getComputedStyle(node).animationName)).toBe("none");
  });

  test("bundled VRM stays active in software and sustains 30 fps on hardware", async ({ page }, testInfo) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });

    const stage = page.getByLabel("VRM character canvas");
    const canvas = stage.locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-framing", "full_body");
    await expectModelAwareCameraTelemetry(canvas, "full_body");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", {
      timeout: 60_000,
    });
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-motion-effective-weight")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.8);
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-motion-time")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expectAnimatedBonePose(canvas);
    const webglRenderer = await canvas.evaluate((element) => {
      const canvasElement = element instanceof HTMLCanvasElement
        ? element
        : element.querySelector("canvas");
      const context = canvasElement?.getContext("webgl2")
        ?? canvasElement?.getContext("webgl");
      const extension = context?.getExtension("WEBGL_debug_renderer_info");
      return extension
        ? String(context?.getParameter(extension.UNMASKED_RENDERER_WEBGL))
        : "unknown WebGL renderer";
    });
    const softwareRenderer = /swiftshader|software renderer/i.test(webglRenderer);
    const requiresHardware = process.env.E2E_REQUIRE_HARDWARE_RENDERING === "1";
    testInfo.annotations.push({
      type: "webgl-renderer",
      description: webglRenderer,
    });
    if (requiresHardware) {
      expect(
        softwareRenderer,
        `Hardware performance lane received software renderer: ${webglRenderer}`,
      ).toBeFalsy();
    }
    const minimumFps = softwareRenderer ? 1 : 30;
    await expect
      .poll(async () => {
        const fps = await stage.getAttribute("data-vrm-fps");
        return fps ? Number.parseFloat(fps) : Number.NaN;
      }, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(minimumFps);

    const sustainedSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await page.waitForTimeout(1_100);
      sustainedSamples.push(
        Number.parseFloat((await stage.getAttribute("data-vrm-fps")) ?? "NaN"),
      );
    }
    const sortedSamples = [...sustainedSamples].sort((left, right) => left - right);
    const medianFps = sortedSamples[Math.floor(sortedSamples.length / 2)] ?? Number.NaN;
    expect(
      medianFps,
      `WebGL renderer: ${webglRenderer}; samples: ${sustainedSamples.join(", ")}`,
    ).toBeGreaterThanOrEqual(minimumFps);
  });

  test("plays one local response gesture per click, Enter, or Space without restarting the avatar runtime", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(responseControl).toBeVisible();
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "4");

    const initialMotionState = await canvas.getAttribute("data-avatar-motion-state");
    const initialActivationCount = await canvas.getAttribute("data-avatar-motion-activation-count");
    expect(Number(initialActivationCount)).toBeGreaterThan(0);
    await installGestureTelemetryRecorder(responseControl, canvas);
    await canvas.evaluate((element) => {
      (window as typeof window & { __e2eGestureCanvas?: Element }).__e2eGestureCanvas = element;
    });
    const lateAssetRequests: string[] = [];
    page.on("request", (request) => {
      if (/\.(?:vrm|vrma)(?:\?|$)/i.test(request.url())) {
        lateAssetRequests.push(request.url());
      }
    });

    await expectOneResponseGesture(responseControl, canvas, () => responseControl.click());
    await expectOneResponseGesture(responseControl, canvas, async () => {
      await responseControl.focus();
      await page.keyboard.down("Enter");
      await responseControl.evaluate((element) => element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          key: "Enter",
          repeat: true,
        }),
      ));
      await page.keyboard.up("Enter");
    });

    await responseControl.scrollIntoViewIfNeeded();
    await responseControl.focus();
    const scrollBeforeSpace = await page.evaluate(() => {
      const maximum = document.documentElement.scrollHeight - window.innerHeight;
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, Math.min(200, maximum));
      return { maximum, position: window.scrollY };
    });
    expect(scrollBeforeSpace.maximum).toBeGreaterThan(0);
    await expectOneResponseGesture(responseControl, canvas, async () => {
      await page.keyboard.down("Space");
      const repeatWasPrevented = await responseControl.evaluate((element) => !element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Space",
          key: " ",
          repeat: true,
        }),
      ));
      expect(repeatWasPrevented).toBeTruthy();
      await page.keyboard.up("Space");
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeSpace.position);

    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", initialMotionState ?? "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect(canvas).toHaveAttribute(
      "data-avatar-motion-activation-count",
      initialActivationCount ?? "1",
    );
    await expect(canvas).toHaveAttribute("data-e2e-motion-contract-violation", "false");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-e2e-motion-time-distinct-count")))
      .toBeGreaterThan(2);
    expect(await canvas.evaluate((element) => (
      (window as typeof window & { __e2eGestureCanvas?: Element }).__e2eGestureCanvas === element
    ))).toBeTruthy();
    expect(lateAssetRequests).toEqual([]);
  });

  test("tracks pointer and touch gaze without replacing or restarting the VRM runtime", async ({ page }) => {
    const assetRequests = { vrm: 0, vrma: 0 };
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname.toLowerCase();
      if (pathname.endsWith(".vrm")) {
        assetRequests.vrm += 1;
      } else if (pathname.endsWith(".vrma")) {
        assetRequests.vrma += 1;
      }
    });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "4");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-target-attached", "true");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", /.+/);
    await expect.poll(() => readNumericTelemetry(canvas, "data-avatar-gaze-output", 2))
      .not.toBeNull();

    const initialActivationCount = await canvas.getAttribute("data-avatar-motion-activation-count");
    const initialMotionState = await canvas.getAttribute("data-avatar-motion-state");
    const runtimeInstance = await canvas.getAttribute("data-avatar-runtime-instance");
    expect(Number(initialActivationCount)).toBeGreaterThan(0);
    expect(runtimeInstance).toBeTruthy();
    const initialOutput = await readNumericTelemetry(canvas, "data-avatar-gaze-output", 2);
    const initialSample = await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3);
    expect(initialOutput).not.toBeNull();
    expect(initialSample).not.toBeNull();
    const loadedAssetRequests = { ...assetRequests };
    expect(loadedAssetRequests.vrm).toBeGreaterThan(0);
    expect(loadedAssetRequests.vrma).toBeGreaterThan(0);
    await installGestureTelemetryRecorder(responseControl, canvas);
    await canvas.evaluate((element) => {
      const testWindow = window as typeof window & { __e2eGazeCanvas?: Element };
      testWindow.__e2eGazeCanvas = element;
    });

    await dispatchGazePointer(responseControl, 0.125, 0.125, "mouse");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-input", "-0.750,0.750");
    await expect.poll(async () => (
      (await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3))?.[0] ?? 0
    )).toBeLessThan(-0.2);
    await expect.poll(async () => (
      (await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3))?.[1] ?? 0
    )).toBeGreaterThan(1.4);
    const topLeftSample = await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3);
    expect(topLeftSample).not.toBeNull();
    const topLeftOutput = await waitForChangedTelemetry(
      canvas,
      "data-avatar-gaze-output",
      initialOutput,
      2,
    );

    await dispatchGazePointer(responseControl, 0.875, 0.875, "mouse");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-input", "0.750,-0.750");
    await expect.poll(async () => (
      (await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3))?.[0] ?? 0
    )).toBeGreaterThan(0.2);
    await expect.poll(async () => (
      (await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3))?.[1] ?? 0
    )).toBeLessThan(1.2);
    const bottomRightSample = await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3);
    expect(bottomRightSample).not.toBeNull();
    const bottomRightOutput = await waitForChangedTelemetry(
      canvas,
      "data-avatar-gaze-output",
      topLeftOutput,
      2,
    );
    expect((topLeftSample ?? [])[0]).toBeLessThan((bottomRightSample ?? [])[0] - 0.1);
    expect((topLeftSample ?? [])[1]).toBeGreaterThan((bottomRightSample ?? [])[1] + 0.1);
    expect(topLeftOutput[0] * bottomRightOutput[0]).toBeLessThan(0);
    expect(Math.abs(topLeftOutput[1] - bottomRightOutput[1])).toBeGreaterThan(0.001);
    expect(vectorDistance(topLeftOutput, bottomRightOutput)).toBeGreaterThan(0.001);
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");

    await expectOneResponseGesture(
      responseControl,
      canvas,
      () => responseControl.evaluate((element) => (element as HTMLElement).click()),
    );
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    await movePointerOutside(page, responseControl);
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    await dispatchGazePointer(responseControl, 0.25, 0.5, "mouse");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");

    await dispatchGazePointerEvent(responseControl, "pointerdown", 0.25, 0.5, "touch");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-input", "-0.500,0.000");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    await dispatchGazePointerEvent(responseControl, "pointerup", 0.25, 0.5, "touch");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");

    await dispatchGazePointerEvent(responseControl, "pointerdown", 0.75, 0.5, "touch");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "pointer");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    await dispatchGazePointerEvent(responseControl, "pointercancel", 0.75, 0.5, "touch");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");

    expect(await canvas.evaluate((element) => (
      (window as typeof window & { __e2eGazeCanvas?: Element }).__e2eGazeCanvas === element
    ))).toBeTruthy();
    expect(assetRequests).toEqual(loadedAssetRequests);
    await expect(canvas).toHaveAttribute(
      "data-avatar-motion-activation-count",
      initialActivationCount ?? "1",
    );
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", initialMotionState ?? "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect(canvas).toHaveAttribute("data-e2e-motion-contract-violation", "false");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-motion-time-distinct-count"),
    )).toBeGreaterThan(2);
  });

  test("keeps actual VRM gaze static when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const stage = page.getByLabel("VRM character canvas");
    const canvas = stage.locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(stage).toHaveAttribute("data-avatar-reduced-motion", "true");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "reduced");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-target-attached", "true");
    await expect.poll(() => readNumericTelemetry(canvas, "data-avatar-gaze-output", 2))
      .not.toBeNull();
    const stableOutput = await readNumericTelemetry(canvas, "data-avatar-gaze-output", 2);
    const stableSample = await readNumericTelemetry(canvas, "data-avatar-gaze-sample", 3);
    expect(stableOutput).not.toBeNull();
    expect(stableSample).not.toBeNull();
    await installStaticGazeRecorder(canvas, stableSample ?? [], stableOutput ?? []);
    await responseControl.evaluate((element) => {
      let mutations = 0;
      new MutationObserver(() => {
        mutations += 1;
        element.setAttribute("data-e2e-reduced-pointer-mutations", String(mutations));
      }).observe(element, {
        attributes: true,
        attributeFilter: ["data-avatar-gaze-input", "data-avatar-gaze-source"],
      });
    });

    await dispatchGazePointer(responseControl, 0.125, 0.125, "mouse");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "reduced");
    await dispatchGazePointerEvent(responseControl, "pointerdown", 0.875, 0.875, "touch");
    await dispatchGazePointerEvent(responseControl, "pointermove", 0.875, 0.875, "touch");
    await dispatchGazePointerEvent(responseControl, "pointerup", 0.875, 0.875, "touch");
    await expect(canvas).toHaveAttribute("data-avatar-gaze-source", "reduced");
    await expect.poll(async () => Number(
      await responseControl.getAttribute("data-e2e-reduced-pointer-mutations"),
    )).toBeGreaterThan(1);
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-static-gaze-sample-count"),
    )).toBeGreaterThan(2);
    await expect(canvas).toHaveAttribute("data-e2e-static-gaze-violation", "false");
  });

  test("keeps the same accessible response control and visible feedback in the 2D fallback", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);
    await openCallPage(page, fixture);

    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const fallback = page.getByTestId("avatar-fallback");
    await expect(fallback).toBeVisible({ timeout: 60_000 });
    await expect(responseControl).toBeVisible();
    await responseControl.focus();
    await expect(responseControl).toBeFocused();
    const initialVisualState = await readFallbackVisualState(fallback);
    const initialSequence = await readGestureSequence(responseControl);
    await responseControl.click();
    await expect.poll(() => readGestureSequence(responseControl)).toBe(initialSequence + 1);
    await expect.poll(() => readFallbackVisualState(fallback)).not.toBe(initialVisualState);
    await expect(responseControl).toHaveAttribute("data-avatar-gesture-state", "idle", {
      timeout: 5_000,
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(responseControl).toHaveAttribute("data-avatar-reduced-motion", "true");
    const reducedVisualState = await readFallbackVisualState(fallback);
    const reducedFilter = await fallback.evaluate((element) => window.getComputedStyle(element).filter);
    const reducedSequence = await readGestureSequence(responseControl);
    await responseControl.press("Enter");
    await expect.poll(() => readGestureSequence(responseControl)).toBe(reducedSequence + 1);
    await expect(fallback).toHaveCSS("animation-name", "none");
    await expect(fallback).toHaveCSS("transform", "none");
    await expect.poll(
      () => fallback.evaluate((element) => window.getComputedStyle(element).filter),
    ).not.toBe(reducedFilter);
    await expect.poll(() => readFallbackVisualState(fallback)).not.toBe(reducedVisualState);
    await expect(responseControl).toHaveAttribute("data-avatar-gesture-state", "idle", {
      timeout: 5_000,
    });
    await expect.poll(
      () => fallback.evaluate((element) => window.getComputedStyle(element).filter),
    ).toBe(reducedFilter);
  });

  test("moves fallback eyes with pointer gaze and freezes them for reduced motion", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);
    await openCallPage(page, fixture);

    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const fallback = page.getByTestId("avatar-fallback");
    const eye = fallback.locator("span").first();
    await expect(fallback).toBeVisible({ timeout: 60_000 });
    await expect(eye).toBeVisible();

    await dispatchGazePointer(responseControl, 0.125, 0.5, "mouse");
    await expect(responseControl).toHaveAttribute("data-avatar-gaze-source", "pointer");
    const left = await waitForNonZeroTranslate(eye);
    await dispatchGazePointer(responseControl, 0.875, 0.5, "mouse");
    const right = await waitForChangedTranslate(eye, left);
    expect(left[0]).toBeLessThan(0);
    expect(right[0]).toBeGreaterThan(0);

    await movePointerOutside(page, responseControl);
    await expect(responseControl).toHaveAttribute("data-avatar-gaze-source", "idle");
    await expect.poll(() => readComputedTranslate(eye)).toEqual([0, 0]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(responseControl).toHaveAttribute("data-avatar-reduced-motion", "true");
    await expect(responseControl).toHaveAttribute("data-avatar-gaze-source", "reduced");
    const reducedTranslate = await readComputedTranslate(eye);
    expect(reducedTranslate).toEqual([0, 0]);
    await installStaticFallbackGazeRecorder(responseControl, eye, reducedTranslate);
    await dispatchGazePointer(responseControl, 0.125, 0.125, "mouse");
    await expect(responseControl).toHaveAttribute("data-avatar-gaze-source", "reduced");
    await dispatchGazePointerEvent(responseControl, "pointerdown", 0.875, 0.875, "touch");
    await dispatchGazePointerEvent(responseControl, "pointermove", 0.875, 0.875, "touch");
    await dispatchGazePointerEvent(responseControl, "pointerup", 0.875, 0.875, "touch");
    await expect(responseControl).toHaveAttribute("data-avatar-gaze-source", "reduced");
    await expect.poll(async () => Number(
      await responseControl.getAttribute("data-e2e-static-fallback-gaze-count"),
    )).toBeGreaterThan(1);
    await expect(responseControl).toHaveAttribute("data-e2e-static-fallback-gaze-violation", "false");
  });

  test("consumes a response gesture without body, gaze, or CSS motion when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(responseControl).toBeVisible();
    await expectStaticAvatarPose(canvas);
    const stableBone = await canvas.getAttribute("data-avatar-motion-bone-sample");
    const stableGaze = await canvas.getAttribute("data-avatar-gaze-sample");
    expect(stableBone).toBeTruthy();
    expect(stableGaze).toBeTruthy();
    await canvas.evaluate((element, baseline) => {
      const inspect = () => {
        if (element.getAttribute("data-avatar-gesture-state") === "reduced") {
          element.setAttribute("data-e2e-reduced-gesture-seen", "true");
        }
        const progress = Number(element.getAttribute("data-avatar-gesture-progress") ?? "0");
        const maximum = Number(element.getAttribute("data-e2e-reduced-max-progress") ?? "0");
        if (Number.isFinite(progress) && progress > maximum) {
          element.setAttribute("data-e2e-reduced-max-progress", String(progress));
        }
        const offset = Number(element.getAttribute("data-avatar-gesture-offset") ?? "0");
        const maximumOffset = Number(element.getAttribute("data-e2e-reduced-max-offset") ?? "0");
        if (Number.isFinite(offset) && Math.abs(offset) > maximumOffset) {
          element.setAttribute("data-e2e-reduced-max-offset", String(Math.abs(offset)));
        }
        const bone = element.getAttribute("data-avatar-motion-bone-sample");
        const gaze = element.getAttribute("data-avatar-gaze-sample");
        if (
          (bone !== null && bone !== baseline.bone)
          || (gaze !== null && gaze !== baseline.gaze)
        ) {
          element.setAttribute("data-e2e-reduced-pose-violation", "true");
        }
      };
      element.setAttribute("data-e2e-reduced-max-offset", "0");
      element.setAttribute("data-e2e-reduced-pose-violation", "false");
      new MutationObserver(inspect).observe(element, {
        attributes: true,
        attributeFilter: [
          "data-avatar-gaze-sample",
          "data-avatar-gesture-offset",
          "data-avatar-gesture-progress",
          "data-avatar-gesture-state",
          "data-avatar-motion-bone-sample",
        ],
      });
      inspect();
    }, { bone: stableBone, gaze: stableGaze });
    const initialSequence = await readGestureSequence(responseControl);
    await responseControl.click();
    await expect.poll(() => readGestureSequence(responseControl)).toBe(initialSequence + 1);
    await expect(canvas).toHaveAttribute("data-e2e-reduced-gesture-seen", "true");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-e2e-reduced-max-progress")))
      .toBeGreaterThan(0);
    await expect(canvas).toHaveAttribute("data-avatar-gesture-state", "idle", {
      timeout: 5_000,
    });
    await expectStaticAvatarPose(canvas);
    await expect(canvas).toHaveAttribute("data-e2e-reduced-pose-violation", "false");
    await expect(canvas).toHaveAttribute("data-e2e-reduced-max-offset", "0");
    await expect(responseControl).toHaveAttribute("data-avatar-gesture-state", "idle", {
      timeout: 5_000,
    });
    await expect(responseControl).toHaveAttribute("data-avatar-gesture-progress", "0.000");
  });

  test("consumes an automatic assistant reaction without bone offsets in reduced-motion mode", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const responseControl = page.getByRole("button", { name: "让角色回应" });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-reaction-reduced-motion", "true");
    const initialSequence = await readGestureSequence(responseControl);
    await canvas.evaluate((element) => {
      const inspect = () => {
        if (element.getAttribute("data-avatar-reaction-state") === "reduced") {
          element.setAttribute("data-e2e-auto-reduced-reaction-seen", "true");
        }
        const maximum = (element.getAttribute("data-avatar-reaction-bone-sample") ?? "")
          .split(",")
          .map(Number)
          .filter(Number.isFinite)
          .reduce((current, value) => Math.max(current, Math.abs(value)), 0);
        const recorded = Number(
          element.getAttribute("data-e2e-auto-reduced-reaction-max") ?? "0",
        );
        if (maximum > recorded) {
          element.setAttribute("data-e2e-auto-reduced-reaction-max", String(maximum));
        }
      };
      element.setAttribute("data-e2e-auto-reduced-reaction-max", "0");
      element.setAttribute("data-e2e-auto-reduced-reaction-seen", "false");
      new MutationObserver(inspect).observe(element, {
        attributes: true,
        attributeFilter: [
          "data-avatar-reaction-bone-sample",
          "data-avatar-reaction-state",
        ],
      });
      inspect();
    });

    await sendTextAndExpectAssistantReply(page, "低动态模式也要接收这轮回应。");
    await expect.poll(() => readGestureSequence(responseControl)).toBe(initialSequence + 1);
    await expect(canvas).toHaveAttribute("data-e2e-auto-reduced-reaction-seen", "true");
    await expect(canvas).toHaveAttribute("data-e2e-auto-reduced-reaction-max", "0");
    await expect(responseControl).not.toHaveAttribute("data-avatar-reaction-key", "none");
  });

  test("reduced-motion mode keeps the avatar body static without disabling the runtime", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    const stage = page.getByLabel("VRM character canvas");
    const canvas = stage.locator("canvas");
    await expect(stage).toHaveAttribute("data-avatar-reduced-motion", "true");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "procedural");
    await expect
      .poll(async () => canvas.getAttribute("data-avatar-motion-action-running"), {
        timeout: 10_000,
      })
      .toBeNull();
    await expectStaticAvatarPose(canvas);

    await canvas.evaluate((element) => {
      const recordFacialWeights = () => {
        if (element.getAttribute("data-avatar-emotion") !== "playful") {
          return;
        }
        for (const [source, maximum] of [
          ["data-avatar-blink-weight", "data-avatar-emotion-blink-max"],
          ["data-avatar-mouth-weight", "data-avatar-emotion-mouth-max"],
        ] as const) {
          const weight = Number.parseFloat(element.getAttribute(source) ?? "0");
          const currentMaximum = Number.parseFloat(element.getAttribute(maximum) ?? "0");
          if (Number.isFinite(weight) && weight > currentMaximum) {
            element.setAttribute(maximum, String(weight));
          }
        }
      };
      new MutationObserver(recordFacialWeights).observe(element, {
        attributes: true,
        attributeFilter: [
          "data-avatar-emotion",
          "data-avatar-blink-weight",
          "data-avatar-mouth-weight",
        ],
      });
    });
    await sendTextAndExpectAssistantReply(page, "低动态模式也请保留温和表情。");
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(canvas).toHaveAttribute("data-avatar-expression", "relaxed");
    await expect(canvas).toHaveAttribute("data-avatar-expression-is-binary", "false");
    await expect(canvas).toHaveAttribute("data-avatar-expression-override-blink", "none");
    await expect(canvas).toHaveAttribute("data-avatar-expression-override-mouth", "none");
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-expression-weight")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-emotion-blink-max")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expectStaticAvatarPose(canvas);

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    const pttButton = page.getByRole("button", { name: "按住说话" });
    await pttButton.focus();
    await page.keyboard.down("Space");
    await injectFakeAudio(page, 0.12, 450);
    await page.keyboard.up("Space");
    await injectFakeAudio(page, 0, 20);
    await expectAvatarState(page, "idle", 20_000);
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "playful");
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-emotion-mouth-max")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expectStaticAvatarPose(canvas);
  });

  test("does not request an untrusted external motion URL from a character recipe", async ({ page }) => {
    let externalMotionRequests = 0;
    await page.route("https://untrusted.invalid/**", async (route) => {
      externalMotionRequests += 1;
      await route.abort("blockedbyclient");
    });
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: {
        ...defaultRecipe,
        motions: {
          idle: "https://untrusted.invalid/companion-idle.vrma",
        },
      },
    });

    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "procedural");
    expect(externalMotionRequests).toBe(0);
  });

  test("imports a VRM into an explainable ready character detail", async ({ page }) => {
    const assetRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/assets/model.vrm")) {
        assetRequests.push(request.url());
      }
    });
    await page.locator('a[href="/characters"]').click();
    const importResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/characters/import")
      && response.request().method() === "POST",
    );
    await page.locator('input[type="file"][accept*=".vrm"]').setInputFiles(
      "apps/web/public/assets/characters/models/VRM1_Constraint_Twist_Sample.vrm",
    );
    const importResponse = await importResponsePromise;
    expect(importResponse.status()).toBe(201);
    await expect(page).toHaveURL(/\/characters\/[^/]+$/, {
      timeout: 120_000,
    });
    const importedId = new URL(page.url()).pathname.split("/").at(-1);
    expect(importedId).toBeTruthy();

    const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
    await expect(readiness).toBeVisible({ timeout: 60_000 });
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 60_000,
    });
    await expect(readiness).toContainText("VRM1_Constraint_Twist_Sample.vrm");
    await expect(readiness).toContainText("VRM 1.0");
    await expect(readiness).toContainText("0 / 4 ready");
    await expect(readiness).toContainText("Safe expressions");
    await expect(readiness).toContainText("relaxed");
    await expect(readiness).toContainText("No recognizable appearance slots");
    await expect(readiness).toContainText("License");
    await expect(readiness).toContainText("Redistribution");
    await expect(readiness).toContainText("Modification");
    await expect(readiness).toContainText("Attribution required");
    await expect(
      readiness.getByText("Redistribution", { exact: true }).locator(".."),
    ).toContainText("yes");
    await expect(
      readiness.getByText("Modification", { exact: true }).locator(".."),
    ).toContainText("yes");
    await expect(
      readiness.getByText("Attribution required", { exact: true }).locator(".."),
    ).toContainText("no");

    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-vrm-version", "VRM 1.0", {
      timeout: 60_000,
    });
    await expectModelAwareCameraTelemetry(canvas, "full_body");
    await expect(canvas).toHaveAttribute("data-avatar-safe-expressions", "relaxed");
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "0");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "0");
    await expect(canvas).toHaveAttribute("data-avatar-appearance-slot-count", "0");
    await expect.poll(() => assetRequests.some((url) =>
      url.includes(`/characters/${importedId}/assets/model.vrm`),
    )).toBe(true);
    await expect
      .poll(async () => Number.parseInt(
        (await canvas.getAttribute("data-avatar-color-material-count")) ?? "0",
        10,
      ))
      .toBeGreaterThan(0);
    await expect
      .poll(async () => Number.parseInt(
        (await canvas.getAttribute("data-avatar-safe-expression-count")) ?? "0",
        10,
      ))
      .toBeGreaterThan(0);
  });

  test("replaces and removes an imported VRM without changing character identity", async ({ page }) => {
    const importResponse = await page.request.post(`${apiBaseUrl}/api/v1/characters/import`, {
      data: readFileSync(
        "apps/web/public/assets/characters/models/VRM1_Constraint_Twist_Sample.vrm",
      ),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "model/gltf-binary",
        "X-Filename": "lifecycle-original.vrm",
      },
    });
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as { id?: string; name?: string };
    expect(imported.id).toBeTruthy();

    await page.locator('a[href="/characters"]').click();
    await page.locator(`a[href="/characters/${imported.id}"]`).first().click();
    const detailPath = `/characters/${imported.id}`;
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
    const originalName = await page.getByLabel("Name").inputValue();
    const originalDescription = await page.getByLabel("Description").inputValue();

    const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
    await expect(readiness).toContainText("lifecycle-original.vrm", { timeout: 60_000 });
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 60_000,
    });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-vrm-version", "VRM 1.0", {
      timeout: 60_000,
    });
    await expectModelAwareCameraTelemetry(canvas, "full_body");
    const vrm1CameraDistance = Number(await canvas.getAttribute("data-camera-distance"));
    await page.getByLabel("Name").fill("Unsaved replacement name");
    let replaceDialogMessage = "";
    page.once("dialog", async (dialog) => {
      replaceDialogMessage = dialog.message();
      await dialog.accept();
    });
    const replaceResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${imported.id}/avatar`)
      && response.request().method() === "PUT",
    );
    const replacementAssetResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/api/v1/characters/${imported.id}/assets/model.vrm`)
      && response.request().method() === "GET",
    );
    await page.getByLabel("替换 VRM 文件").setInputFiles(
      "apps/web/public/assets/characters/models/Sendagaya-Shino.vrm",
    );
    expect((await replaceResponsePromise).status()).toBe(200);
    expect((await replacementAssetResponsePromise).status()).toBe(200);
    expect(replaceDialogMessage).toContain("未保存编辑会丢失");
    await expect(readiness).toContainText("Sendagaya-Shino.vrm", { timeout: 120_000 });
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 120_000,
    });
    await expect(readiness).toContainText("VRM 0.x");
    await expect(canvas).toHaveAttribute("data-avatar-vrm-version", "VRM 0.x", {
      timeout: 120_000,
    });
    await expectModelAwareCameraTelemetry(canvas, "full_body");
    const vrm0CameraDistance = Number(await canvas.getAttribute("data-camera-distance"));
    expect(Math.abs(vrm1CameraDistance - vrm0CameraDistance)).toBeGreaterThan(0.01);
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
    await expect(page.getByLabel("Name")).toHaveValue(originalName);
    await expect(page.getByLabel("Description")).toHaveValue(originalDescription);
    const expectedReplacementBytes = readFileSync(
      "apps/web/public/assets/characters/models/Sendagaya-Shino.vrm",
    );
    const replacedAsset = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/model.vrm`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(replacedAsset.status()).toBe(200);
    expect(await replacedAsset.body()).toEqual(expectedReplacementBytes);

    page.once("dialog", (dialog) => dialog.accept());
    const invalidResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${imported.id}/avatar`)
      && response.request().method() === "PUT",
    );
    await page.getByLabel("替换 VRM 文件").setInputFiles({
      name: "broken.vrm",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from("not a vrm", "utf8"),
    });
    expect((await invalidResponsePromise).status()).toBe(400);
    await expect(page.getByText(/^替换角色模型失败：/)).toBeVisible();
    await expect(readiness).toContainText("Sendagaya-Shino.vrm");
    const assetAfterInvalidReplace = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/model.vrm`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(assetAfterInvalidReplace.status()).toBe(200);
    expect(await assetAfterInvalidReplace.body()).toEqual(expectedReplacementBytes);

    await page.route(
      `**/api/v1/characters/${imported.id}/assets/model.vrm`,
      async (route) => route.abort("failed"),
    );
    page.once("dialog", (dialog) => dialog.accept());
    const persistedReplacementResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${imported.id}/avatar`)
      && response.request().method() === "PUT",
    );
    const failedAssetRequestPromise = page.waitForRequest((request) =>
      request.url().includes(`/api/v1/characters/${imported.id}/assets/model.vrm`)
      && request.method() === "GET",
    );
    await page.getByLabel("替换 VRM 文件").setInputFiles(
      "apps/web/public/assets/characters/models/Seed-san.vrm",
    );
    expect((await persistedReplacementResponsePromise).status()).toBe(200);
    await failedAssetRequestPromise;
    await expect(readiness).toContainText("Seed-san.vrm", { timeout: 60_000 });
    await expect(readiness).toHaveAttribute("data-capability-source", "previous-preview", {
      timeout: 60_000,
    });
    await expect(readiness).toContainText("The new attached asset failed to load");
    await expect(readiness).toContainText("previous preview remains visible");
    await expect(readiness.getByText("Runtime inspected", { exact: true })).toHaveCount(0);
    await expect(readiness).not.toContainText("VRM 0.x");
    await expect(canvas).toHaveAttribute("data-avatar-vrm-version", "VRM 0.x", {
      timeout: 120_000,
    });
    const persistedReplacementBytes = readFileSync(
      "apps/web/public/assets/characters/models/Seed-san.vrm",
    );
    const persistedReplacementAsset = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/model.vrm`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(persistedReplacementAsset.status()).toBe(200);
    expect(await persistedReplacementAsset.body()).toEqual(persistedReplacementBytes);
    await page.unroute(`**/api/v1/characters/${imported.id}/assets/model.vrm`);

    await page.getByLabel("Name").fill("Unsaved removal name");
    let removeDialogMessage = "";
    page.once("dialog", async (dialog) => {
      removeDialogMessage = dialog.message();
      await dialog.accept();
    });
    const removeResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${imported.id}/avatar`)
      && response.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "恢复内置模型" }).click();
    expect((await removeResponsePromise).status()).toBe(200);
    expect(removeDialogMessage).toContain("未保存编辑会丢失");
    await expect(page.getByRole("button", { name: "恢复内置模型" })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
    await expect(page.getByLabel("Name")).toHaveValue(originalName);
    await expect(page.getByLabel("Description")).toHaveValue(originalDescription);
    await expect(page.getByText("Built-in avatar", { exact: true })).toBeVisible();
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 120_000,
    });
    await expect(canvas).toHaveAttribute("data-avatar-vrm-version", "VRM 1.0", {
      timeout: 120_000,
    });
    const removedAsset = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/model.vrm`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(removedAsset.status()).toBe(404);
  });

  test("manages a local idle VRMA overlay without mutating its recipe or surrounding state", async ({ page }) => {
    const recipeWithoutMotions = { ...defaultRecipe, motions: {} };
    const character = await postJson(page.request, "/api/v1/characters", ownerToken, {
      name: `Managed motion ${Date.now()}`,
      description: "Managed VRMA overlay E2E",
      recipe: recipeWithoutMotions,
    }) as {
      id: string;
      name: string;
      recipe: typeof recipeWithoutMotions;
      asset_manifest: Record<string, unknown>;
      updated_at: string;
    };
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };
    const spacesBeforeResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
      headers: authHeaders,
    });
    expect(spacesBeforeResponse.ok()).toBeTruthy();
    const spacesBefore = await spacesBeforeResponse.json();
    const sessionSnapshot = async (spaces: unknown) => {
      const items = Array.isArray(spaces) ? spaces as Array<{ id?: string }> : [];
      return Promise.all(items.map(async ({ id }) => {
        expect(id).toBeTruthy();
        const response = await page.request.get(
          `${apiBaseUrl}/api/v1/spaces/${id}/sessions`,
          { headers: authHeaders },
        );
        expect(response.ok()).toBeTruthy();
        return [id, await response.json()] as const;
      }));
    };
    const sessionsBefore = await sessionSnapshot(spacesBefore);
    const originalRecipe = structuredClone(character.recipe);
    const originalModelPath = character.asset_manifest.model_path;
    const motionBytes = readFileSync(
      "apps/web/public/assets/characters/motions/companion-idle.vrma",
    );
    const browserVrmaRequests: string[] = [];
    const browserVrmaResponses: Array<{ contentType: string; status: number; url: string }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.toLowerCase().endsWith(".vrma")) {
        browserVrmaRequests.push(request.url());
      }
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.toLowerCase().endsWith(".vrma")) {
        browserVrmaResponses.push({
          contentType: response.headers()["content-type"] ?? "",
          status: response.status(),
          url: response.url(),
        });
      }
    });

    await page.locator('a[href="/characters"]').click();
    await page.locator(`a[href="/characters/${character.id}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/characters/${character.id}$`));
    await expect(page.getByText(
      "Direct upload is local-only, license unverified, and export blocked until removed.",
      { exact: false },
    )).toBeVisible();
    const runtime = page.locator("[data-runtime-mode]").first();
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "0");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "0");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "procedural");
    expect(browserVrmaRequests).toEqual([]);
    await page.getByLabel("Name").fill("discard this unsaved edit");

    let uploadDialog = "";
    page.once("dialog", async (dialog) => {
      uploadDialog = dialog.message();
      await dialog.accept();
    });
    const putResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${character.id}/motions/idle`)
      && response.request().method() === "PUT",
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Idle VRMA" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "companion-idle.vrma",
      mimeType: "application/octet-stream",
      buffer: motionBytes,
    });
    const putResponse = await putResponsePromise;
    expect(putResponse.status()).toBe(200);
    expect(uploadDialog).toContain("resets unsaved editor changes");
    expect(putResponse.request().headers()["content-type"]).toBe("application/octet-stream");
    expect(putResponse.request().headers()["x-filename"]).toBe("companion-idle.vrma");
    const uploaded = await putResponse.json() as typeof character & {
      asset_manifest: {
        managed_motions?: Record<string, {
          path?: string;
          source_filename?: string;
          sha256?: string;
          provenance?: string;
          redistribution_allowed?: string;
        }>;
      };
    };
    expect(uploaded.recipe).toEqual(originalRecipe);
    expect(uploaded.asset_manifest.model_path).toBe(originalModelPath);
    const overlay = uploaded.asset_manifest.managed_motions?.idle;
    expect(overlay).toMatchObject({
      source_filename: "companion-idle.vrma",
      provenance: "owner_upload",
      redistribution_allowed: "no",
    });
    expect(overlay?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(overlay?.path).toBe(`managed-motions/idle-${overlay?.sha256}.vrma`);
    const expectedBrowserAssetPath = `/api/v1/characters/${character.id}/assets/${overlay?.path}`;
    await expect.poll(() => browserVrmaRequests.filter(
      (url) => new URL(url).pathname === expectedBrowserAssetPath,
    ).length).toBe(1);
    expect(browserVrmaRequests.filter((url) =>
      new URL(url).pathname !== expectedBrowserAssetPath,
    )).toEqual([]);
    await expect.poll(() => browserVrmaResponses.some(({ contentType, status, url }) =>
      new URL(url).pathname === expectedBrowserAssetPath
      && status === 200
      && contentType === "model/gltf-binary",
    )).toBe(true);
    await expect(page.getByLabel("Name")).toHaveValue(character.name);
    await expect(page.getByText("companion-idle.vrma", { exact: true })).toBeVisible();
    await expect(page.getByText("Local only · export blocked", { exact: true })).toBeVisible();

    const assetResponse = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${character.id}/assets/${overlay?.path}`,
      { headers: authHeaders },
    );
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()["content-type"]).toBe("model/gltf-binary");
    expect(await assetResponse.body()).toEqual(motionBytes);

    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "1");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "1", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-avatar-motion-time"),
    )).toBeGreaterThan(0.05);
    await expectAnimatedBonePose(canvas);

    const blockedExport = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${character.id}/export`,
      { headers: authHeaders },
    );
    expect(blockedExport.status()).toBe(400);

    page.once("dialog", (dialog) => dialog.accept());
    const deleteResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/characters/${character.id}/motions/idle`)
      && response.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Remove Idle VRMA" }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBe(200);
    const removed = await deleteResponse.json() as typeof uploaded;
    expect(removed.recipe).toEqual(originalRecipe);
    expect(removed.asset_manifest.managed_motions?.idle).toBeUndefined();
    expect((await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${character.id}/assets/${overlay?.path}`,
      { headers: authHeaders },
    )).status()).toBe(404);

    const repeatedDelete = await page.request.delete(
      `${apiBaseUrl}/api/v1/characters/${character.id}/motions/idle`,
      { headers: authHeaders },
    );
    expect(repeatedDelete.status()).toBe(200);
    const repeated = await repeatedDelete.json() as typeof removed;
    expect(repeated.updated_at).toBe(removed.updated_at);
    expect(repeated.asset_manifest.managed_motions?.idle).toBeUndefined();
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "0", {
      timeout: 60_000,
    });
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "0");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "procedural");
    await expect(canvas).not.toHaveAttribute("data-avatar-motion-action-running", "true");
    expect(browserVrmaRequests.map((url) => new URL(url).pathname)).toEqual([
      expectedBrowserAssetPath,
    ]);

    const restoredExport = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${character.id}/export`,
      { headers: authHeaders },
    );
    expect(restoredExport.status()).toBe(200);

    const spacesAfterResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
      headers: authHeaders,
    });
    expect(spacesAfterResponse.ok()).toBeTruthy();
    const spacesAfter = await spacesAfterResponse.json();
    expect(spacesAfter).toEqual(spacesBefore);
    expect(await sessionSnapshot(spacesAfter)).toEqual(sessionsBefore);
    expect(repeated.recipe).toEqual(originalRecipe);
  });

  test("keeps an imported character persisted when WebGL preview is unavailable", async ({ page }) => {
    const importResponse = await page.request.post(`${apiBaseUrl}/api/v1/characters/import`, {
      data: readFileSync(
        "apps/web/public/assets/characters/models/VRM1_Constraint_Twist_Sample.vrm",
      ),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "model/gltf-binary",
        "X-Filename": "runtime-fallback-constraint.vrm",
      },
    });
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as { id?: string };
    expect(imported.id).toBeTruthy();

    await page.evaluate(disableWebGL);
    await page.locator('a[href="/characters"]').click();
    await page.locator(`a[href="/characters/${imported.id}"]`).first().click();

    const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
    await expect(readiness).toHaveAttribute("data-capability-source", "error", {
      timeout: 60_000,
    });
    await expect(readiness).toContainText("runtime-fallback-constraint.vrm");
    await expect(readiness).toContainText("Preview failed after import");
    await expect(readiness).toContainText("saved character recipe and asset manifest remain");
    await expect(page.getByTestId("avatar-fallback")).toBeVisible();
  });

  test("reports configured motions that fail runtime loading as degraded", async ({ page }) => {
    await page.route("**/assets/characters/motions/companion-thinking.vrma", async (route) => {
      await route.abort("failed");
    });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await page.locator('a[href="/characters"]').click();
    await page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click();

    const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 60_000,
    });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "4");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "3", {
      timeout: 60_000,
    });
    await expect(readiness).toContainText("3 / 4 ready");
    await expect(readiness).toContainText("Missing or unusable motion states");
  });

  test("keeps a declared pack motion visible when its protected asset download fails", async ({ page }) => {
    const characterId = await importBlobMotionCharacter(page.request, ownerToken);
    await page.route(
      `**/api/v1/characters/${characterId}/assets/motions/idle.vrma`,
      async (route) => {
        await route.abort("failed");
      },
    );
    await page.locator('a[href="/characters"]').click();
    await page.locator(`a[href="/characters/${characterId}"]`).first().click();

    const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
    await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
      timeout: 60_000,
    });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "1");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "0");
    await expect(readiness).toContainText("0 / 4 ready · 1 configured");
    await expect(readiness).toContainText("Missing or unusable motion states");
    await expect(readiness).toContainText("CC0-1.0");
    await expect(
      readiness.getByText("Redistribution", { exact: true }).locator(".."),
    ).toContainText("yes");
  });

  test("plays a manifest-authorized character-pack motion through a temporary Blob URL", async ({ page }) => {
    const characterId = await importBlobMotionCharacter(page.request, ownerToken);
    const assetRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/characters/${characterId}/assets/`)) {
        assetRequests.push(request.url());
      }
    });
    const fixture = await createRealtimeFixture(page.request, ownerToken, { characterId });

    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", {
      timeout: 60_000,
    });
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-configured-count", "1");
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "1");
    await expectAnimatedBonePose(canvas);
    expect(assetRequests.some((url) => url.includes("motions/idle.vrma"))).toBeTruthy();

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    await dispatchSyntheticRealtimeState(page, "thinking");
    await expect(canvas).toHaveAttribute("data-avatar-motion-requested-state", "thinking");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "procedural");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "thinking");
    await expect
      .poll(async () => canvas.getAttribute("data-avatar-motion-action-running"))
      .toBeNull();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready");

    await dispatchSyntheticRealtimeState(page, "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "idle");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expectAnimatedBonePose(canvas);
    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("keeps realtime captions, interruption, and session ending available after VRM fallback", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await routeSpaceTtsAsNonBuiltIn(page, fixture.spaceId);

    await page.route("**/*.vrm", async (route) => {
      await route.abort("failed");
    });
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    await expect(page.getByTestId("avatar-fallback")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const fallbackPrompt = "VRM 全部失败后还能继续实时讲解吗？";
    await commitRealtimeText(page, fallbackPrompt);
    await expectRealtimeReply(page, fallbackPrompt);
    const playbackMeter = await waitForPlayback(page);
    await page.getByRole("button", { name: "立即打断" }).click();
    await expect(playbackMeter).toHaveAttribute("data-playback-level", "0", { timeout: 1_000 });

    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("records submit-to-scheduled-playback latency from the browser playback signal", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: { ...defaultRecipe, avatar_model: "mori_2d" },
    });
    await routeSpaceTtsAsNonBuiltIn(page, fixture.spaceId);

    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await expect(
      page.locator('[data-runtime-kind="sprite_2d"][data-runtime-instance="mori_2d"]').first(),
    ).toHaveAttribute("data-runtime-mode", "ready", { timeout: 20_000 });

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const sessionId = await getRealtimeSessionId(page);
    const firstPlaybackLatencyMsPromise = waitForPersistedLocalMetricValue(
      page,
      "first_audio_latency_ms",
      sessionId,
      ownerToken,
    );

    await commitFakeVoice(page);

    const firstPlaybackLatencyMs = await firstPlaybackLatencyMsPromise;
    expect(firstPlaybackLatencyMs).toBeGreaterThan(0);
    expect(firstPlaybackLatencyMs).toBeLessThanOrEqual(firstPlaybackLatencyBudgetMs);
  });

  test("keeps text conversation available when WebGL is unavailable", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: {
        ...defaultRecipe,
        stage_background: "midnight",
      },
    });

    await page.addInitScript(disableWebGL);
    await page.evaluate(disableWebGL);
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    const runtime = page.locator("[data-runtime-mode]").first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "fallback", { timeout: 5_000 });
    await expect(runtime).toHaveAttribute("data-runtime-detail", /不支持 WebGL/);
    await expect(runtime).toHaveAttribute("data-avatar-stage-background", "midnight");
    await expect
      .poll(() => runtime.evaluate((element) => window.getComputedStyle(element).backgroundImage))
      .toMatch(/rgb\(16, 29, 51\).*rgb\(7, 17, 31\).*rgb\(5, 11, 20\)/);
    await expect(page.getByTestId("avatar-fallback")).toBeVisible();

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "没有 WebGL 时还能继续文字学习吗？";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
  });

  test("shows mic permission guidance when getUserMedia is denied and text composer still works", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await page.evaluate(() => {
      const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          ...mediaDevices,
          getUserMedia: async () => {
            throw new DOMException("Permission denied", "NotAllowedError");
          },
        },
      });
    });

    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();

    await expect(
      page.getByText("麦克风权限被拒绝，请在浏览器站点设置中允许麦克风后重试；当前仍可输入文字。"),
    ).toBeVisible({ timeout: 20_000 });
    await sendTextAndExpectAssistantReply(page, "没有麦克风权限时请继续用文字回答。");
  });

  test("waits for session.open before requesting the microphone", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);
    await installRejectedRealtimeSocket(page, 4404);

    await page.getByRole("button", { name: "开始语音" }).click();

    await expect(
      page.getByText(/实时会话不存在或已经失效/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("text", { exact: true })).toBeVisible();
    const getUserMediaCalls = await page.evaluate(() => (
      window as typeof window & { __e2eGetUserMediaCalls?: number }
    ).__e2eGetUserMediaCalls ?? 0);
    expect(getUserMediaCalls).toBe(0);
  });

  test("push-to-talk commits injected PCM below the VAD threshold after microphone setup", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await routeSpaceTtsAsNonBuiltIn(page, fixture.spaceId);

    await page.route("**/*.vrm", async (route) => {
      await route.abort("failed");
    });
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "按住说话" }).evaluate((button) => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      button.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    await expect(page.getByText("按住说话中…", { exact: true })).toHaveCount(0);

    await holdToTalkBelowVad(page, 550);
    await expect(page.getByText("按住说话已发送").first()).toBeVisible({ timeout: 20_000 });
    await expectRealtimeReply(page, "这是一段用于联调语音链路的模拟转写。");

    const assistantTurns = page.locator('[data-role="assistant"]');
    const assistantCount = await assistantTurns.count();
    await holdToTalkBelowVad(page, 120);
    await expect(assistantTurns).toHaveCount(assistantCount + 1, { timeout: 20_000 });
    await expect(assistantTurns.last()).toContainText("模拟回复");
    await expect(page.getByText(/Realtime session already has an active turn/)).toHaveCount(0);
  });

  test("waits for the space voice policy before a session can start", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await Promise.all([
      page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
      page.getByRole("link", { name: "学习空间" }).first().click(),
    ]);
    const spaceCard = page.locator("article.info-card").filter({ hasText: fixture.spaceName });
    await Promise.all([
      page.waitForURL(new RegExp(`/spaces/${fixture.spaceId}$`), { timeout: 20_000 }),
      spaceCard.locator(`a[href="/spaces/${fixture.spaceId}"]`).first().click(),
    ]);
    const startCallLink = page.getByRole("link", { name: "开始伴学会话" });
    await expect(startCallLink).toBeVisible({ timeout: 20_000 });

    let releaseSpacePolicy = () => {};
    const spacePolicyGate = new Promise<void>((resolve) => {
      releaseSpacePolicy = resolve;
    });
    await page.route(`**/api/v1/spaces/${fixture.spaceId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await spacePolicyGate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    const sessionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/sessions")) {
        sessionRequests.push(request.url());
      }
    });
    await Promise.all([
      page.waitForURL(fixture.callPath, { timeout: 20_000 }),
      startCallLink.click(),
    ]);

    const startVoiceButton = page.getByRole("button", { name: "开始语音", exact: true });
    const sendTextButton = page.getByRole("button", { name: "发送文本", exact: true });
    await expect(startVoiceButton).toBeDisabled();
    await expect(startVoiceButton).toHaveText("正在读取语音配置…");
    await expect(sendTextButton).toBeDisabled();
    await expect(sendTextButton).toHaveText("正在读取语音配置…");
    await expect(page.getByRole("textbox", { name: "发送文字消息", exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "把今天的知识点复习成 3 句短口诀。" }),
    ).toBeDisabled();
    await startVoiceButton.evaluate((button) => (button as HTMLButtonElement).click());
    await page.waitForTimeout(100);
    expect(sessionRequests).toEqual([]);

    releaseSpacePolicy();
    await expect(page.getByLabel("兼容系统朗读")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "开始语音" })).toBeEnabled();
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    expect(sessionRequests).toHaveLength(1);

    const prompt = "语音策略确定后再开始这一轮。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          pcmStarts: number;
          serverFinalCount: number;
          spoken: unknown[];
        };
      }).__e2eBuiltInVoice;
      return Boolean(
        probe &&
        probe.serverFinalCount === 1 &&
        probe.pcmStarts === 0 &&
        probe.spoken.length === 1,
      );
    })).toBe(true);
  });

  test("recovers after the space voice policy request fails once", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await Promise.all([
      page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
      page.getByRole("link", { name: "学习空间" }).first().click(),
    ]);
    const spaceCard = page.locator("article.info-card").filter({ hasText: fixture.spaceName });
    await Promise.all([
      page.waitForURL(new RegExp(`/spaces/${fixture.spaceId}$`), { timeout: 20_000 }),
      spaceCard.locator(`a[href="/spaces/${fixture.spaceId}"]`).first().click(),
    ]);

    let allowPolicyRead = false;
    let policyReads = 0;
    await page.route(`**/api/v1/spaces/${fixture.spaceId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      policyReads += 1;
      if (!allowPolicyRead) {
        await route.fulfill({
          contentType: "application/json",
          json: { detail: "temporary policy failure" },
          status: 503,
        });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    const sessionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/sessions")) {
        sessionRequests.push(request.url());
      }
    });

    await Promise.all([
      page.waitForURL(fixture.callPath, { timeout: 20_000 }),
      page.getByRole("link", { name: "开始伴学会话" }).click(),
    ]);
    const policyAlert = page.getByRole("alert").filter({
      hasText: "读取空间语音配置失败",
    });
    const startVoiceButton = page.getByRole("button", { name: "开始语音", exact: true });
    const sendTextButton = page.getByRole("button", { name: "发送文本", exact: true });
    await expect(policyAlert).toBeVisible();
    await expect(startVoiceButton).toBeDisabled();
    await expect(startVoiceButton).toHaveText("语音配置不可用");
    await expect(sendTextButton).toBeDisabled();
    await expect(sendTextButton).toHaveText("语音配置不可用");
    await expect(page.getByRole("textbox", { name: "发送文字消息", exact: true })).toBeDisabled();
    expect(sessionRequests).toEqual([]);

    allowPolicyRead = true;
    await page.getByRole("button", { name: "重试语音配置" }).click();
    await expect(page.getByLabel("兼容系统朗读")).toBeVisible({ timeout: 20_000 });
    await expect(policyAlert).toHaveCount(0);
    await expect(page.getByRole("button", { name: "开始语音" })).toBeEnabled();
    expect(policyReads).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    expect(sessionRequests).toHaveLength(1);
  });

  test("keeps the explicitly labeled system voice compatibility path for mock TTS", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await page.route("**/*.vrm", async (route) => {
      await route.abort("failed");
    });
    await installFakeMicrophone(page);

    await openCallPage(page, fixture);
    const voiceSelect = page.getByLabel("兼容系统朗读");
    await expect(voiceSelect).toBeVisible();
    await expect(voiceSelect.locator("option")).toHaveText([
      "明亮（系统）",
      "柔和（系统）",
      "偏甜（系统）",
      "舒缓（系统）",
      "青年（系统）",
      "关闭声音（保留文字）",
    ]);
    await voiceSelect.selectOption("soft");
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    await expect(voiceSelect).toBeDisabled();
    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { holdOpen: boolean };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.holdOpen = true;
    });

    await dispatchSyntheticMockTtsBlobs(page, 2);
    await expect(page.getByText(/未声明的二进制音频帧/)).toHaveCount(0);

    const interruptionPrompt = "请用实时语音复述这条打断断言。";
    await commitRealtimeText(page, interruptionPrompt);
    await expectRealtimeReply(page, interruptionPrompt);
    const playbackMeter = await waitForPlayback(page);
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          pcmStarts: number;
          serverFinalCount: number;
          spoken: Array<{
            lang: string;
            pitch: number;
            rate: number;
            text: string;
            voiceURI: string | null;
          }>;
        };
      }).__e2eBuiltInVoice;
      return probe
        ? {
            pcmStarts: probe.pcmStarts,
            serverFinalCount: probe.serverFinalCount,
            spoken: probe.spoken,
          }
        : null;
    })).toEqual({
      pcmStarts: 0,
      serverFinalCount: 1,
      spoken: [{
        lang: "zh-CN",
        pitch: expect.closeTo(1.26, 6),
        rate: expect.closeTo(0.96, 6),
        text: expect.stringContaining("模拟回复"),
        voiceURI: "e2e-soft",
      }],
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { pcmStarts: number; serverFinalCount: number };
      }).__e2eBuiltInVoice;
      return probe
        ? { pcmStarts: probe.pcmStarts, serverFinalCount: probe.serverFinalCount }
        : null;
    })).toEqual({ pcmStarts: 0, serverFinalCount: 1 });

    const stopLatencyMs = await page.getByRole("button", { name: "立即打断" }).evaluate(
      (button) => new Promise<number>((resolve, reject) => {
        const meter = document.querySelector<HTMLElement>("[data-playback-level]");
        const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
          .__e2eRealtimeSocket;
        if (!meter || !socket) {
          reject(new Error("Playback meter or realtime socket was not found."));
          return;
        }

        const startedAt = performance.now();
        let stoppedAt: number | null = null;
        let interruptAcknowledged = false;
        const cleanup = () => {
          window.clearTimeout(timeout);
          observer.disconnect();
          socket.removeEventListener("message", handleMessage);
        };
        const finishIfReady = () => {
          if (stoppedAt === null || !interruptAcknowledged) {
            return;
          }
          cleanup();
          resolve(stoppedAt - startedAt);
        };
        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const payload = JSON.parse(event.data) as { type?: unknown };
            if (payload.type === "turn.interrupted") {
              interruptAcknowledged = true;
              finishIfReady();
            }
          } catch {
            // The application validates malformed realtime messages separately.
          }
        };
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("Playback did not stop or acknowledge interruption within three seconds."));
        }, 3_000);
        const finishIfStopped = () => {
          const level = Number.parseFloat(meter.dataset.playbackLevel ?? "0");
          if (level > 0 || stoppedAt !== null) {
            return;
          }
          stoppedAt = performance.now();
          finishIfReady();
        };
        const observer = new MutationObserver(finishIfStopped);
        observer.observe(meter, {
          attributes: true,
          attributeFilter: ["data-playback-level"],
        });
        socket.addEventListener("message", handleMessage);
        (button as HTMLButtonElement).click();
        finishIfStopped();
      }),
    );
    expect(stopLatencyMs).toBeLessThanOrEqual(250);
    await expect(playbackMeter).toHaveAttribute("data-playback-level", "0");
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eBuiltInVoice?: { cancelCount: number } }
    ).__e2eBuiltInVoice?.cancelCount ?? 0)).toBe(1);

    await sendTextAndExpectAssistantReply(page, "打断之后请继续用文字回答。");
  });

  test("plays the built-in neural connection through server PCM without SpeechSynthesis", async ({ page }) => {
    const neuralConnectionResponse = await page.request.get(
      `${apiBaseUrl}/api/v1/providers/connections/builtin-neural-tts`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    test.skip(
      neuralConnectionResponse.status() === 404,
      "The optional built-in neural TTS integration is disabled for this API process.",
    );
    expect(
      neuralConnectionResponse.status(),
      "This test requires the isolated API to start with BUILTIN_NEURAL_TTS_ENABLED=true.",
    ).toBe(200);
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await postJson(page.request, `/api/v1/spaces/${fixture.spaceId}/assignments`, ownerToken, {
      capability: "tts",
      provider_connection_id: "builtin-neural-tts",
      model_name: "qwen3-tts-0.6b-customvoice",
    });
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);

    await expect(page.getByText("本地神经语音", { exact: true })).toBeVisible();
    await expect(page.getByLabel("兼容系统朗读")).toHaveCount(0);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "神经语音必须播放服务端 PCM。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          pcmStarts: number;
          serverFinalCount: number;
          spoken: unknown[];
        };
      }).__e2eBuiltInVoice;
      return probe
        ? {
            pcmStarted: probe.pcmStarts > 0,
            serverFinalCount: probe.serverFinalCount,
            spoken: probe.spoken.length,
          }
        : null;
    }), { timeout: 60_000 }).toEqual({ pcmStarted: true, serverFinalCount: 1, spoken: 0 });
  });

  test("persists a fixed neural speaker and forwards it to voice preview", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken, {
      recipe: {
        ...defaultRecipe,
        voice_provider: "local-neural",
        voice_model: "qwen3-tts-0.6b-customvoice",
        voice_id: "Serena",
      },
    });
    await page.route("**/*.vrm", async (route) => {
      await route.abort("failed");
    });
    await Promise.all([
      page.waitForURL(/\/characters$/, { timeout: 20_000 }),
      page.locator('a[href="/characters"]').click(),
    ]);
    await Promise.all([
      page.waitForURL(new RegExp(`/characters/${fixture.characterId}$`), { timeout: 20_000 }),
      page.locator(`a[href="/characters/${fixture.characterId}"]`).first().click(),
    ]);

    await expect(page.getByLabel("Voice Provider")).toHaveValue("local-neural");
    await expect(page.getByLabel("Voice Model")).toHaveValue("qwen3-tts-0.6b-customvoice");
    await expect(page.getByText(/默认走 builtin-neural-tts/)).toBeVisible();
    const voiceSelect = page.getByLabel("Voice ID");
    await expect(voiceSelect.locator("option")).toHaveText([
      "Serena · 温柔女声",
      "Vivian · 明亮女声",
      "Dylan · 北京青年男声",
      "Eric · 成都活力男声",
      "Uncle Fu · 成熟男声",
    ]);
    await voiceSelect.selectOption("Dylan");

    const saveResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/api/v1/characters/${fixture.characterId}`),
    );
    await page.getByRole("button", { name: "保存角色" }).click();
    const saveResponse = await saveResponsePromise;
    expect(saveResponse.ok()).toBeTruthy();
    const savedCharacter = await saveResponse.json() as {
      recipe?: { voice_id?: unknown; voice_model?: unknown; voice_provider?: unknown };
    };
    expect(savedCharacter.recipe).toMatchObject({
      voice_id: "Dylan",
      voice_model: "qwen3-tts-0.6b-customvoice",
      voice_provider: "local-neural",
    });
    await expect(voiceSelect).toHaveValue("Dylan");

    const previewRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/v1/characters/${fixture.characterId}/voice-preview`),
    );
    await page.getByRole("button", { name: "试听声音" }).click();
    const previewPayload = (await previewRequestPromise).postDataJSON() as {
      speaking_rate?: unknown;
      voice_id?: unknown;
    };
    expect(previewPayload).toMatchObject({ speaking_rate: 1, voice_id: "Dylan" });
  });

  test("keeps concerned voice tuning while delayed local voices load and cancels safely", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          forcedEmotion: "concerned" | null;
          voicesReady: boolean;
        };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.forcedEmotion = "concerned";
      probe.voicesReady = false;
    });

    await openCallPage(page, fixture);
    await page.getByLabel("兼容系统朗读").selectOption("healing");
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const delayedPrompt = "请等本机语音加载完成后再朗读。";
    await commitRealtimeText(page, delayedPrompt);
    await expectRealtimeReply(page, delayedPrompt);
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { spoken: unknown[]; voiceReadCount: number };
      }).__e2eBuiltInVoice;
      return Boolean(probe && probe.voiceReadCount >= 2 && probe.spoken.length === 0);
    })).toBe(true);

    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { voicesReady: boolean };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.voicesReady = true;
      window.speechSynthesis.dispatchEvent(new Event("voiceschanged"));
    });
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          current: SpeechSynthesisUtterance | null;
          serverFinalCount: number;
          spoken: Array<{ pitch: number; rate: number; voiceURI: string | null }>;
        };
      }).__e2eBuiltInVoice;
      return probe
        ? {
            current: probe.current !== null,
            serverFinalCount: probe.serverFinalCount,
            spoken: probe.spoken.map(({ pitch, rate, voiceURI }) => ({ pitch, rate, voiceURI })),
          }
        : null;
    })).toEqual({
      current: false,
      serverFinalCount: 1,
      spoken: [{
        pitch: expect.closeTo(0.96, 6),
        rate: expect.closeTo(0.8, 6),
        voiceURI: "e2e-soft",
      }],
    });

    const readsBeforeCancel = await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { voiceReadCount: number; voicesReady: boolean };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.voicesReady = false;
      return probe.voiceReadCount;
    });
    const canceledPrompt = "这句在语音加载时会被打断。";
    await commitRealtimeText(page, canceledPrompt);
    await expectRealtimeReply(page, canceledPrompt);
    await expect.poll(() => page.evaluate((previousReads) => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { spoken: unknown[]; voiceReadCount: number };
      }).__e2eBuiltInVoice;
      return Boolean(
        probe && probe.voiceReadCount > previousReads && probe.spoken.length === 1,
      );
    }, readsBeforeCancel)).toBe(true);
    await page.getByRole("button", { name: "立即打断" }).click();
    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { voicesReady: boolean };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.voicesReady = true;
      window.speechSynthesis.dispatchEvent(new Event("voiceschanged"));
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (
      window as typeof window & { __e2eBuiltInVoice?: { spoken: unknown[] } }
    ).__e2eBuiltInVoice?.spoken.length ?? -1)).toBe(1);
  });

  test("keeps text and stays silent when no local system voice becomes available", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { voicesReady: boolean };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.voicesReady = false;
    });
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "没有系统语音时也要保留这段文字。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    await expect(page.getByText(/没有检测到本机语音/)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          current: SpeechSynthesisUtterance | null;
          pcmStarts: number;
          serverFinalCount: number;
          spoken: unknown[];
        };
      }).__e2eBuiltInVoice;
      return probe
        ? {
            current: probe.current !== null,
            pcmStarts: probe.pcmStarts,
            serverFinalCount: probe.serverFinalCount,
            spoken: probe.spoken.length,
          }
        : null;
    })).toEqual({ current: false, pcmStarts: 0, serverFinalCount: 1, spoken: 0 });
  });

  test("does not read Chinese replies with an English-only local voice", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: { availableVoices: SpeechSynthesisVoice[] };
      }).__e2eBuiltInVoice;
      if (!probe) {
        throw new Error("Built-in voice probe is unavailable.");
      }
      probe.availableVoices = [{
        default: true,
        lang: "en-US",
        localService: true,
        name: "Microsoft David Desktop",
        voiceURI: "e2e-english-only",
      }] as SpeechSynthesisVoice[];
    });
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "只有英文系统音色时请保持静音并保留中文文字。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    await expect(page.getByText(/没有检测到本机语音/)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          pcmStarts: number;
          serverFinalCount: number;
          spoken: unknown[];
        };
      }).__e2eBuiltInVoice;
      return probe
        ? {
            pcmStarts: probe.pcmStarts,
            serverFinalCount: probe.serverFinalCount,
            spoken: probe.spoken.length,
          }
        : null;
    })).toEqual({ pcmStarts: 0, serverFinalCount: 1, spoken: 0 });
  });

  for (const lifecycle of ["end session", "leave page"] as const) {
    test(`cancels held local speech when users ${lifecycle}`, async ({ page }) => {
      const fixture = await createRealtimeFixture(page.request, ownerToken);
      await installFakeMicrophone(page);
      await openCallPage(page, fixture);
      await page.getByRole("button", { name: "开始语音" }).click();
      await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
      await page.evaluate(() => {
        const probe = (window as typeof window & {
          __e2eBuiltInVoice?: { holdOpen: boolean };
        }).__e2eBuiltInVoice;
        if (!probe) {
          throw new Error("Built-in voice probe is unavailable.");
        }
        probe.holdOpen = true;
      });
      const prompt = `请保持朗读，直到用户${lifecycle === "end session" ? "结束会话" : "离开页面"}。`;
      await commitRealtimeText(page, prompt);
      await expectRealtimeReply(page, prompt);
      await waitForPlayback(page);

      if (lifecycle === "end session") {
        await page.getByRole("button", { name: "结束会话" }).click();
        await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
      } else {
        await Promise.all([
          page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
          page.getByRole("link", { name: "学习空间" }).first().click(),
        ]);
      }
      await expect.poll(() => page.evaluate(() => {
        const probe = (window as typeof window & {
          __e2eBuiltInVoice?: {
            cancelCount: number;
            current: SpeechSynthesisUtterance | null;
          };
        }).__e2eBuiltInVoice;
        return probe
          ? { cancelCount: probe.cancelCount, current: probe.current !== null }
          : null;
      })).toEqual({ cancelCount: 1, current: false });
    });
  }

  test("stops realtime media in the background without restarting it on foreground", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __e2eBuiltInVoice?: { holdOpen: boolean };
        __e2eRealtimeSocket?: WebSocket;
        __e2eRealtimeSendCount?: number;
      };
      const probe = testWindow.__e2eBuiltInVoice;
      const socket = testWindow.__e2eRealtimeSocket;
      if (!probe || !socket) {
        throw new Error("Realtime lifecycle probes are unavailable.");
      }
      probe.holdOpen = true;
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        testWindow.__e2eRealtimeSendCount = (testWindow.__e2eRealtimeSendCount ?? 0) + 1;
        nativeSend(data);
      };
      testWindow.__e2eRealtimeSendCount = 0;
    });

    const prompt = "切到后台时必须立即停止所有实时音频。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    const playbackMeter = await waitForPlayback(page);
    await injectFakeAudio(page, 0.12, 100);
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eRealtimeSendCount?: number }
    ).__e2eRealtimeSendCount ?? 0)).toBeGreaterThan(0);

    const sendsAtBackground = await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return (window as typeof window & { __e2eRealtimeSendCount?: number })
        .__e2eRealtimeSendCount ?? 0;
    });

    await expect(playbackMeter).toHaveAttribute("data-playback-level", "0");
    await expect.poll(() => page.evaluate(() => {
      const testWindow = window as typeof window & {
        __e2eBuiltInVoice?: {
          cancelCount: number;
          current: SpeechSynthesisUtterance | null;
          pcmStarts: number;
        };
        __e2eMicStream?: MediaStream;
        __e2eRealtimeSocket?: WebSocket;
      };
      return {
        cancelCount: testWindow.__e2eBuiltInVoice?.cancelCount ?? 0,
        currentSpeech: testWindow.__e2eBuiltInVoice?.current !== null,
        pcmStarts: testWindow.__e2eBuiltInVoice?.pcmStarts ?? 0,
        socketOpen: testWindow.__e2eRealtimeSocket?.readyState === WebSocket.OPEN,
        tracks: testWindow.__e2eMicStream?.getTracks().map((track) => track.readyState) ?? [],
      };
    })).toEqual({
      cancelCount: 1,
      currentSpeech: false,
      pcmStarts: 0,
      socketOpen: false,
      tracks: ["ended"],
    });

    await injectFakeAudio(page, 0.12, 100);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __e2eBuiltInVoice?: { current: SpeechSynthesisUtterance | null; pcmStarts: number };
        __e2eGetUserMediaCalls?: number;
        __e2eRealtimeSendCount?: number;
      };
      return {
        currentSpeech: testWindow.__e2eBuiltInVoice?.current !== null,
        getUserMediaCalls: testWindow.__e2eGetUserMediaCalls ?? 0,
        pcmStarts: testWindow.__e2eBuiltInVoice?.pcmStarts ?? 0,
        sendCount: testWindow.__e2eRealtimeSendCount ?? 0,
      };
    })).toEqual({
      currentSpeech: false,
      getUserMediaCalls: 1,
      pcmStarts: 0,
      sendCount: sendsAtBackground,
    });
    await expect(page.getByText(prompt)).toBeVisible();
  });

  test("requests a realtime ticket after an expired native owner token refresh", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    let ticketRequests = 0;
    await page.route("**/api/v1/sessions", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await route.continue();
    });
    await page.route("**/api/v1/sessions/*/realtime-ticket", async (route) => {
      ticketRequests += 1;
      await route.continue();
    });
    await page.addInitScript((token) => {
      const nativeWindow = window as typeof window & {
        Capacitor?: {
          PluginHeaders: Array<{
            methods: Array<{ name: string; rtype: "promise" }>;
            name: string;
          }>;
          nativePromise: (pluginName: string, methodName: string) => Promise<unknown>;
        };
        __e2eNativeRefreshCount?: number;
        androidBridge?: object;
      };
      nativeWindow.androidBridge = {};
      nativeWindow.__e2eNativeRefreshCount = 0;
      nativeWindow.Capacitor = {
        PluginHeaders: [{
          name: "CompanionAuth",
          methods: [
            "clearAccessToken",
            "clearAuth",
            "getAccessToken",
            "refreshAccessToken",
            "returnToLauncher",
          ].map((name) => ({ name, rtype: "promise" as const })),
        }],
        nativePromise: async (pluginName, methodName) => {
          if (pluginName !== "CompanionAuth") throw new Error(`Unexpected plugin: ${pluginName}`);
          if (methodName === "getAccessToken") {
            return { value: null, expiresAt: null };
          }
          if (methodName === "refreshAccessToken") {
            nativeWindow.__e2eNativeRefreshCount = (nativeWindow.__e2eNativeRefreshCount ?? 0) + 1;
            return { value: token, expiresAt: new Date(Date.now() + 300_000).toISOString() };
          }
          return {};
        },
      };
    }, ownerToken);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(1);
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();

    await expect.poll(() => ticketRequests, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(1);
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });
  });

  test("invalidates a pending native refresh without breaking single-flight", async ({ page }) => {
    let markLockRequested: (() => void) | undefined;
    let releaseLockResponse: (() => void) | undefined;
    const lockRequested = new Promise<void>((resolve) => {
      markLockRequested = resolve;
    });
    const lockResponseReleased = new Promise<void>((resolve) => {
      releaseLockResponse = resolve;
    });

    await page.route("**/api/v1/vault/lock", async (route) => {
      markLockRequested?.();
      await lockResponseReleased;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Invalid owner session" }),
      });
    });
    await page.addInitScript((token) => {
      const nativeWindow = window as typeof window & {
        Capacitor?: {
          PluginHeaders: Array<{
            methods: Array<{ name: string; rtype: "promise" }>;
            name: string;
          }>;
          nativePromise: (pluginName: string, methodName: string) => Promise<unknown>;
        };
        __e2eNativeRefreshCount?: number;
        __e2eResolveNativeRefresh?: () => void;
        __e2eReturnToLauncherCount?: number;
        androidBridge?: object;
      };
      nativeWindow.androidBridge = {};
      nativeWindow.__e2eNativeRefreshCount = 0;
      nativeWindow.__e2eReturnToLauncherCount = 0;
      nativeWindow.Capacitor = {
        PluginHeaders: [{
          name: "CompanionAuth",
          methods: [
            "clearAccessToken",
            "clearAuth",
            "getAccessToken",
            "refreshAccessToken",
            "returnToLauncher",
          ].map((name) => ({ name, rtype: "promise" as const })),
        }],
        nativePromise: async (pluginName, methodName) => {
          if (pluginName !== "CompanionAuth") throw new Error(`Unexpected plugin: ${pluginName}`);
          if (methodName === "getAccessToken") {
            return { value: null, expiresAt: null };
          }
          if (methodName === "refreshAccessToken") {
            nativeWindow.__e2eNativeRefreshCount = (nativeWindow.__e2eNativeRefreshCount ?? 0) + 1;
            if (nativeWindow.__e2eNativeRefreshCount === 1) {
              return {
                value: token,
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              };
            }
            return await new Promise((resolve) => {
              nativeWindow.__e2eResolveNativeRefresh = () => resolve({
                value: token,
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              });
            });
          }
          if (methodName === "returnToLauncher") {
            nativeWindow.__e2eReturnToLauncherCount = (nativeWindow.__e2eReturnToLauncherCount ?? 0) + 1;
          }
          return {};
        },
      };
    }, ownerToken);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(1);
    await Promise.all([
      page.waitForURL(/\/vault$/, { timeout: 20_000 }),
      page.locator('a[href="/vault"]').first().evaluate((element) => {
        (element as HTMLAnchorElement).click();
      }),
    ]);
    const unlockedCallout = page.locator(".success-callout").first();
    await expect(unlockedCallout).toBeVisible();

    const lockClick = page.locator(".vault-layout button[type='button']").last().click();
    await Promise.race([
      lockRequested,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Vault lock request did not start")), 20_000);
      }),
    ]);
    await page.evaluate(() => {
      const currentTime = Date.now.bind(Date);
      Date.now = () => currentTime() + 280_000;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(2);

    releaseLockResponse?.();
    await lockClick;
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __e2eReturnToLauncherCount?: number }
    ).__e2eReturnToLauncherCount ?? 0)).toBe(1);
    await expect(unlockedCallout).toBeHidden();
    expect(await page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(2);

    await page.evaluate(() => {
      (window as typeof window & { __e2eResolveNativeRefresh?: () => void })
        .__e2eResolveNativeRefresh?.();
    });
    await page.waitForTimeout(250);
    await expect(unlockedCallout).toBeHidden();
    expect(await page.evaluate(() => (
      window as typeof window & { __e2eNativeRefreshCount?: number }
    ).__e2eNativeRefreshCount ?? 0)).toBe(2);
  });

  test("keeps server PCM for a non-built-in connection with a matching model name", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    const connection = await postJson(page.request, "/api/v1/providers/connections", ownerToken, {
      provider: "mock",
      label: `Server PCM ${fixture.spaceId}`,
      api_key: "mock-key",
    });
    await postJson(page.request, `/api/v1/spaces/${fixture.spaceId}/assignments`, ownerToken, {
      capability: "tts",
      provider_connection_id: connection.id,
      model_name: "mock-voice-v1",
    });
    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await expect(page.getByLabel("兼容系统朗读")).toHaveCount(0);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "同名模型也必须沿用真实连接的音频。";
    await commitRealtimeText(page, prompt);
    await expectRealtimeReply(page, prompt);
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as typeof window & {
        __e2eBuiltInVoice?: {
          pcmStarts: number;
          serverFinalCount: number;
          spoken: unknown[];
        };
      }).__e2eBuiltInVoice;
      return Boolean(
        probe &&
        probe.serverFinalCount === 1 &&
        probe.pcmStarts > 0 &&
        probe.spoken.length === 0,
      );
    })).toBe(true);
  });

  test("renders board updates emitted by the realtime websocket", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const prompt = "请画一张白板解释这个知识点。";
    await commitRealtimeText(page, prompt);

    const boardPanel = page.locator("section.panel").filter({ hasText: "当前板书" });
    await expect(boardPanel.getByText("关键概念")).toBeVisible({ timeout: 20_000 });
    await expect(boardPanel.getByText("因果关系")).toBeVisible();
    await expect(boardPanel.getByText("下一步问题")).toBeVisible();
    await expectRealtimeReply(page, prompt);

    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("avatar runtime state follows realtime session state transitions", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);

    await installFakeMicrophone(page);
    await openCallPage(page, fixture);
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const avatar = page.locator("[data-avatar-state]").first();
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expectAvatarState(page, "idle", 20_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "neutral");
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma", {
      timeout: 60_000,
    });
    await avatar.evaluate((element) => {
      const recordState = () => {
        const state = element.getAttribute("data-avatar-state");
        if (!state) {
          return;
        }
        const states = (element.getAttribute("data-avatar-state-history") ?? "")
          .split(",")
          .filter(Boolean);
        states.push(state);
        element.setAttribute("data-avatar-state-history", states.join(","));
      };
      recordState();
      new MutationObserver(recordState).observe(element, {
        attributes: true,
        attributeFilter: ["data-avatar-state"],
      });
    });
    await canvas.evaluate((element) => {
      const recordFacialWeights = () => {
        if (element.getAttribute("data-avatar-emotion") !== "playful") {
          return;
        }
        for (const [source, maximum] of [
          ["data-avatar-mouth-weight", "data-avatar-emotion-mouth-max"],
          ["data-avatar-blink-weight", "data-avatar-emotion-blink-max"],
        ] as const) {
          const weight = Number.parseFloat(element.getAttribute(source) ?? "0");
          const currentMaximum = Number.parseFloat(element.getAttribute(maximum) ?? "0");
          if (Number.isFinite(weight) && weight > currentMaximum) {
            element.setAttribute(maximum, String(weight));
          }
        }
      };
      recordFacialWeights();
      new MutationObserver(recordFacialWeights).observe(element, {
        attributes: true,
        attributeFilter: [
          "data-avatar-emotion",
          "data-avatar-mouth-weight",
          "data-avatar-blink-weight",
        ],
      });
    });
    await dispatchSyntheticRealtimeState(page, "thinking");
    await expectAvatarState(page, "thinking", 5_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "focused");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "focused");
    await expect(canvas).toHaveAttribute("data-avatar-expression", "relaxed");
    await expect(canvas).toHaveAttribute("data-avatar-motion-requested-state", "thinking");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "thinking");
    await dispatchSyntheticRealtimeState(page, "idle");
    await expectAvatarState(page, "idle", 5_000);
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "idle");

    const pttButton = page.getByRole("button", { name: "按住说话" });
    await pttButton.focus();
    await page.keyboard.down("Space");
    await expectAvatarState(page, "listening", 5_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "curious");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "curious");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "listening");
    await injectFakeAudio(page, 0.12, 450);
    await page.keyboard.up("Space");
    await injectFakeAudio(page, 0, 20);

    await expect
      .poll(async () => (await avatar.getAttribute("data-avatar-state-history")) ?? "", {
        timeout: 20_000,
      })
      .toContain("speaking");
    await expectAvatarState(page, "idle", 20_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(canvas).toHaveAttribute("data-avatar-expression", "relaxed");
    await expect(canvas).toHaveAttribute("data-avatar-expression-is-binary", "false");
    await expect(canvas).toHaveAttribute("data-avatar-expression-override-blink", "none");
    await expect(canvas).toHaveAttribute("data-avatar-expression-override-mouth", "none");
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-expression-weight")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.19);
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-emotion-mouth-max")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expect
      .poll(async () => Number.parseFloat(
        (await canvas.getAttribute("data-avatar-emotion-blink-max")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.05);
    await expect(canvas).toHaveAttribute("data-avatar-motion-mode", "vrma");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await expectAnimatedBonePose(canvas);

    let releaseTextTurn = () => {};
    const textTurnGate = new Promise<void>((resolve) => {
      releaseTextTurn = resolve;
    });
    await page.route("**/api/v1/sessions/*/turns/stream", async (route) => {
      await textTurnGate;
      await route.continue();
    });
    const resetMessage = "新问题应该先清除上一轮表情。";
    const composer = page.getByLabel("发送文字消息");
    await composer.fill(resetMessage);
    const sendButton = page.getByRole("button", { name: "发送文本" });
    await expect(sendButton).toBeEnabled({ timeout: 20_000 });
    await sendButton.click();
    await expect(page.locator('[data-role="user"]').last()).toContainText(resetMessage);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "focused");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "focused");
    releaseTextTurn();
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("模拟回复", {
      timeout: 20_000,
    });
    await page.unroute("**/api/v1/sessions/*/turns/stream");
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(pttButton).toBeEnabled();

    await pttButton.focus();
    await page.keyboard.down("Space");
    await expectAvatarState(page, "listening", 5_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "curious");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "curious");
    await expect(canvas).toHaveAttribute("data-avatar-motion-state", "listening");
    await expect(canvas).toHaveAttribute("data-avatar-motion-action-running", "true");
    await pttButton.evaluate((element) => (element as HTMLElement).blur());
    await page.keyboard.up("Space");
    await expectAvatarState(page, "idle", 5_000);
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "neutral");

    await sendTextAndExpectAssistantReply(page, "结束会话前再恢复一次角色表情。");
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "playful");

    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(avatar).toHaveAttribute("data-avatar-emotion", "neutral");
    await expect(canvas).toHaveAttribute("data-avatar-emotion", "neutral");
    await expect(canvas).toHaveAttribute("data-avatar-expression", "none");
    await expect(canvas).toHaveAttribute("data-avatar-expression-weight", "0.000");
  });

  test("accepted assistant finals trigger one emotion body reaction without reloading 3D assets", async ({ page }) => {
    const assetRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith(".vrm") || pathname.endsWith(".vrma")) {
        assetRequests.push(pathname);
      }
    });
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const runtime = page.getByRole("button", { name: "让角色回应" });
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-kind", "vrm");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "4", {
      timeout: 60_000,
    });
    const runtimeInstance = await canvas.getAttribute("data-avatar-runtime-instance");
    expect(runtimeInstance).toBeTruthy();
    const initialSequence = Number(
      await canvas.getAttribute("data-avatar-reaction-sequence") ?? "0",
    );
    const assetRequestCountAtReady = assetRequests.length;

    await installAutomaticReactionTelemetryRecorder(canvas);

    await sendTextAndExpectAssistantReply(page, "用一个俯身动作回应我。");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-max-sequence") ?? "0",
    )).toBe(initialSequence + 1);
    await expect(canvas).toHaveAttribute("data-avatar-reaction-duration", "1.30");
    await expect(canvas).toHaveAttribute("data-e2e-reaction-active-seen", "true");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-rendered-offset-max") ?? "0",
    )).toBeGreaterThan(0.001);
    const firstReactionKey = await canvas.getAttribute("data-avatar-reaction-key");
    expect(firstReactionKey).toBeTruthy();
    expect(firstReactionKey).not.toBe("none");
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    expect(assetRequests).toHaveLength(assetRequestCountAtReady);
    await expectAutomaticReactionToSettleOnce(canvas, initialSequence + 1);

    await sendTextAndExpectAssistantReply(page, "用相同情绪再回应一次。");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-max-sequence") ?? "0",
    )).toBe(initialSequence + 2);
    const secondReactionKey = await canvas.getAttribute("data-avatar-reaction-key");
    expect(secondReactionKey).toBeTruthy();
    expect(secondReactionKey).not.toBe(firstReactionKey);
    await expect.poll(async () => (
      await canvas.getAttribute("data-e2e-reaction-keys") ?? ""
    ).split("|").filter(Boolean).length).toBe(2);
    await expect(canvas).toHaveAttribute("data-avatar-runtime-instance", runtimeInstance ?? "");
    expect(assetRequests).toHaveLength(assetRequestCountAtReady);
    await expectAutomaticReactionToSettleOnce(canvas, initialSequence + 2);
  });

  test("restored assistant history establishes a reaction baseline before the next final", async ({ page }) => {
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    const session = await postJson(page.request, "/api/v1/sessions", ownerToken, {
      space_id: fixture.spaceId,
      character_pack_id: fixture.characterId,
    }) as { id: string };
    await postJson(
      page.request,
      `/api/v1/sessions/${session.id}/turns`,
      ownerToken,
      { text: "historical assistant final used only for hydration" },
    );

    await page.locator('a[href="/sessions"]').first().click();
    const resumePath = `${fixture.callPath}?session=${encodeURIComponent(session.id)}`;
    await page.locator(`a[href="${resumePath}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${resumePath.replace("?", "\\?")}$`));
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(1, { timeout: 20_000 });

    const runtime = page.locator('[data-runtime-kind="vrm"]').first();
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-avatar-motion-ready-count", "4", {
      timeout: 60_000,
    });
    await expect(runtime).toHaveAttribute("data-avatar-reaction-sequence", "0");
    await expect(runtime).toHaveAttribute("data-avatar-reaction-key", "none");

    await installAutomaticReactionTelemetryRecorder(canvas);
    await sendTextAndExpectAssistantReply(page, "new assistant final should react exactly once");
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-max-sequence") ?? "0",
    )).toBe(1);
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-rendered-offset-max") ?? "0",
    )).toBeGreaterThan(0.001);
    await expect(runtime).toHaveAttribute("data-avatar-reaction-sequence", "1");
  });

  test("queues one assistant reaction until the VRM runtime becomes ready", async ({ page }) => {
    let releaseModel = () => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    await page.route("**/*.vrm", async (route) => {
      await modelGate;
      await route.continue();
    });

    const fixture = await createRealtimeFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const runtime = page.locator('[data-runtime-kind="vrm"]').first();
    const canvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(runtime).not.toHaveAttribute("data-runtime-mode", "ready");
    await installAutomaticReactionTelemetryRecorder(canvas);

    await sendTextAndExpectAssistantReply(page, "reply before the avatar runtime is ready");
    await expect(runtime).toHaveAttribute("data-avatar-reaction-sequence", "0");
    const queuedReactionKey = await runtime.getAttribute("data-avatar-reaction-key");
    expect(queuedReactionKey).toBeTruthy();
    expect(queuedReactionKey).not.toBe("none");

    releaseModel();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-max-sequence") ?? "0",
    )).toBe(1);
    await expect.poll(async () => Number(
      await canvas.getAttribute("data-e2e-reaction-rendered-offset-max") ?? "0",
    )).toBeGreaterThan(0.001);
    await expect(runtime).toHaveAttribute("data-avatar-reaction-sequence", "1");
    await expect(runtime).toHaveAttribute("data-avatar-gesture-state", "idle", {
      timeout: 5_000,
    });
    await page.waitForTimeout(500);
    await expect(runtime).toHaveAttribute("data-avatar-reaction-sequence", "1");
    await page.unroute("**/*.vrm");
  });
});

async function expectModelAwareCameraTelemetry(
  canvas: ReturnType<Page["locator"]>,
  framing: "full_body" | "portrait",
) {
  await expect(canvas).toHaveAttribute("data-avatar-framing", framing);
  await expect(canvas).toHaveAttribute("data-camera-fit-source", /^(humanoid|visible-bounds)$/);
  await expect(canvas).toHaveAttribute("data-avatar-bounds-size", /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-frame-size", /^\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-target", /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-distance", /^\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-occupancy", /^0(?:\.\d+)?$|^1(?:\.0+)?$|^0?\.\d+$/);
  await expect(canvas).toHaveAttribute("data-camera-vertical-occupancy", /^0(?:\.\d+)?$|^1(?:\.0+)?$|^0?\.\d+$/);
  const distance = Number(await canvas.getAttribute("data-camera-distance"));
  const occupancy = Number(await canvas.getAttribute("data-camera-occupancy"));
  const verticalOccupancy = Number(await canvas.getAttribute("data-camera-vertical-occupancy"));
  const bounds = (await canvas.getAttribute("data-avatar-bounds-size"))!.split(",").map(Number);
  const frameSize = (await canvas.getAttribute("data-camera-frame-size"))!.split(",").map(Number);
  expect(bounds).toHaveLength(3);
  expect(frameSize).toHaveLength(3);
  expect(bounds.every((value) => Number.isFinite(value) && value > 0)).toBeTruthy();
  expect(frameSize.every((value) => Number.isFinite(value) && value > 0)).toBeTruthy();
  expect(Number.isFinite(distance) && distance > 0).toBeTruthy();
  expect(Number.isFinite(occupancy) && occupancy > 0 && occupancy <= 1).toBeTruthy();
  expect(Number.isFinite(verticalOccupancy) && verticalOccupancy > 0 && verticalOccupancy <= 1).toBeTruthy();
}

async function expectAvatarState(
  page: Page,
  avatarState: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error" | "closed",
  timeoutMs = 20_000,
) {
  const avatar = page.locator("[data-avatar-state]").first();
  await expect(avatar).toHaveAttribute("data-avatar-state", avatarState, { timeout: timeoutMs });
}

async function expectAnimatedBonePose(canvas: ReturnType<Page["locator"]>) {
  await expect
    .poll(async () => (await canvas.getAttribute("data-avatar-motion-bone-sample")) ?? "", {
      timeout: 10_000,
    })
    .not.toBe("");
  const firstPose = await canvas.getAttribute("data-avatar-motion-bone-sample");
  await expect
    .poll(async () => canvas.getAttribute("data-avatar-motion-bone-sample"), {
      timeout: 5_000,
    })
    .not.toBe(firstPose);
}

async function expectStaticAvatarPose(canvas: ReturnType<Page["locator"]>) {
  await canvas.evaluate((element) => new Promise<void>((resolve, reject) => {
    let previousSample: string | null = null;
    let observer: MutationObserver | null = null;
    const timeout = window.setTimeout(() => {
      observer?.disconnect();
      reject(new Error("Avatar pose did not remain stable across two telemetry batches."));
    }, 10_000);
    const finish = () => {
      window.clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };
    const inspect = () => {
      const bone = element.getAttribute("data-avatar-motion-bone-sample");
      const gaze = element.getAttribute("data-avatar-gaze-sample");
      if (!bone || !gaze) {
        previousSample = null;
        return;
      }
      const sample = `${bone}\n${gaze}`;
      if (sample === previousSample) {
        finish();
        return;
      }
      previousSample = sample;
    };
    observer = new MutationObserver(inspect);
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-avatar-gaze-sample"],
    });
    inspect();
  }));
}

async function installGestureTelemetryRecorder(
  responseControl: ReturnType<Page["locator"]>,
  canvas: ReturnType<Page["locator"]>,
) {
  await responseControl.evaluate((element) => {
    const inspect = () => {
      if (element.getAttribute("data-avatar-gesture-state") === "active") {
        element.setAttribute("data-e2e-gesture-active-seen", "true");
      }
      const progress = Number.parseFloat(
        element.getAttribute("data-avatar-gesture-progress") ?? "0",
      );
      const maximum = Number.parseFloat(
        element.getAttribute("data-e2e-gesture-max-progress") ?? "0",
      );
      if (Number.isFinite(progress) && progress > maximum) {
        element.setAttribute("data-e2e-gesture-max-progress", String(progress));
      }
    };
    new MutationObserver(inspect).observe(element, {
      attributes: true,
      attributeFilter: ["data-avatar-gesture-progress", "data-avatar-gesture-state"],
    });
    inspect();
  });
  await canvas.evaluate((element) => {
    const expectedMotion = {
      mode: element.getAttribute("data-avatar-motion-mode"),
      running: element.getAttribute("data-avatar-motion-action-running"),
      state: element.getAttribute("data-avatar-motion-state"),
    };
    const distinctMotionTimes = new Set<string>();
    element.setAttribute("data-e2e-motion-contract-violation", "false");
    const inspect = () => {
      const offset = (element.getAttribute("data-avatar-gesture-offset") ?? "0")
        .split(",")
        .map(Number)
        .filter(Number.isFinite)
        .reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
      const maximum = Number.parseFloat(
        element.getAttribute("data-e2e-gesture-max-offset") ?? "0",
      );
      if (offset > maximum) {
        element.setAttribute("data-e2e-gesture-max-offset", String(offset));
      }
      const motionTime = element.getAttribute("data-avatar-motion-time");
      if (motionTime !== null) {
        distinctMotionTimes.add(motionTime);
        element.setAttribute(
          "data-e2e-motion-time-distinct-count",
          String(distinctMotionTimes.size),
        );
        if (
          element.getAttribute("data-avatar-motion-mode") !== expectedMotion.mode
          || element.getAttribute("data-avatar-motion-state") !== expectedMotion.state
          || element.getAttribute("data-avatar-motion-action-running") !== expectedMotion.running
        ) {
          element.setAttribute("data-e2e-motion-contract-violation", "true");
        }
      }
    };
    new MutationObserver(inspect).observe(element, {
      attributes: true,
      attributeFilter: ["data-avatar-gesture-offset", "data-avatar-motion-time"],
    });
    inspect();
  });
}

async function installAutomaticReactionTelemetryRecorder(
  canvas: ReturnType<Page["locator"]>,
) {
  await canvas.evaluate((element) => {
    const recordReaction = () => {
      const sequence = Number(element.getAttribute("data-avatar-reaction-sequence") ?? "0");
      const maximumSequence = Number(
        element.getAttribute("data-e2e-reaction-max-sequence") ?? "0",
      );
      if (Number.isFinite(sequence) && sequence > maximumSequence) {
        element.setAttribute("data-e2e-reaction-max-sequence", String(sequence));
      }
      if (element.getAttribute("data-avatar-reaction-state") === "active") {
        element.setAttribute("data-e2e-reaction-active-seen", "true");
        if (element.getAttribute("data-e2e-reaction-active-sequence") !== String(sequence)) {
          element.setAttribute("data-e2e-reaction-active-sequence", String(sequence));
          element.setAttribute("data-e2e-reaction-active-at", String(performance.now()));
        }
      } else if (
        element.getAttribute("data-avatar-reaction-state") === "idle"
        && element.getAttribute("data-e2e-reaction-active-sequence") === String(sequence)
        && element.getAttribute("data-e2e-reaction-recorded-sequence") !== String(sequence)
      ) {
        const activeAt = Number(element.getAttribute("data-e2e-reaction-active-at"));
        if (Number.isFinite(activeAt)) {
          element.setAttribute(
            "data-e2e-reaction-duration-ms",
            String(performance.now() - activeAt),
          );
          element.setAttribute("data-e2e-reaction-recorded-sequence", String(sequence));
        }
      }
      const renderedOffset = (element.getAttribute("data-avatar-gesture-offset") ?? "0")
        .split(",")
        .map(Number)
        .filter(Number.isFinite)
        .reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
      const recordedMaximum = Number(
        element.getAttribute("data-e2e-reaction-rendered-offset-max") ?? "0",
      );
      if (renderedOffset > recordedMaximum) {
        element.setAttribute(
          "data-e2e-reaction-rendered-offset-max",
          String(renderedOffset),
        );
      }
      const key = element.getAttribute("data-avatar-reaction-key");
      if (key && key !== "none") {
        const keys = new Set(
          (element.getAttribute("data-e2e-reaction-keys") ?? "").split("|").filter(Boolean),
        );
        keys.add(key);
        element.setAttribute("data-e2e-reaction-keys", [...keys].join("|"));
      }
    };
    element.setAttribute("data-e2e-reaction-active-seen", "false");
    element.setAttribute("data-e2e-reaction-rendered-offset-max", "0");
    element.setAttribute("data-e2e-reaction-max-sequence", "0");
    element.setAttribute("data-e2e-reaction-keys", "");
    element.setAttribute("data-e2e-reaction-active-sequence", "");
    element.setAttribute("data-e2e-reaction-recorded-sequence", "");
    element.setAttribute("data-e2e-reaction-duration-ms", "0");
    new MutationObserver(recordReaction).observe(element, {
      attributes: true,
      attributeFilter: [
        "data-avatar-gesture-offset",
        "data-avatar-reaction-key",
        "data-avatar-reaction-sequence",
        "data-avatar-reaction-state",
      ],
    });
    recordReaction();
  });
}

async function expectAutomaticReactionToSettleOnce(
  canvas: ReturnType<Page["locator"]>,
  expectedSequence: number,
) {
  await expect(canvas).toHaveAttribute("data-avatar-reaction-state", "idle", {
    timeout: 5_000,
  });
  await expect.poll(async () => Number(
    await canvas.getAttribute("data-e2e-reaction-recorded-sequence") ?? "0",
  )).toBe(expectedSequence);
  const measuredDurationMs = Number(
    await canvas.getAttribute("data-e2e-reaction-duration-ms") ?? "0",
  );
  expect(measuredDurationMs).toBeGreaterThanOrEqual(1_100);
  expect(measuredDurationMs).toBeLessThanOrEqual(1_800);

  await canvas.page().waitForTimeout(350);
  await expect(canvas).toHaveAttribute(
    "data-avatar-reaction-sequence",
    String(expectedSequence),
  );
  await expect(canvas).toHaveAttribute(
    "data-e2e-reaction-max-sequence",
    String(expectedSequence),
  );
}

async function expectOneResponseGesture(
  responseControl: ReturnType<Page["locator"]>,
  canvas: ReturnType<Page["locator"]>,
  trigger: () => Promise<unknown>,
) {
  const initialSequence = await readGestureSequence(responseControl);
  await responseControl.evaluate((element) => {
    element.setAttribute("data-e2e-gesture-active-seen", "false");
    element.setAttribute("data-e2e-gesture-max-progress", "0");
  });
  await canvas.evaluate((element) => {
    element.setAttribute("data-e2e-gesture-max-offset", "0");
  });

  await trigger();
  await expect.poll(() => readGestureSequence(responseControl)).toBe(initialSequence + 1);
  await expect(responseControl).toHaveAttribute("data-e2e-gesture-active-seen", "true");
  await expect
    .poll(async () => Number(await responseControl.getAttribute("data-e2e-gesture-max-progress")))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-e2e-gesture-max-offset")))
    .toBeGreaterThan(0);
  await expect(responseControl).toHaveAttribute("data-avatar-gesture-state", "idle", {
    timeout: 5_000,
  });
  await expect(responseControl).toHaveAttribute("data-avatar-gesture-progress", "0.000");
  await expect
    .poll(async () => (await canvas.getAttribute("data-avatar-gesture-offset") ?? "")
      .split(",")
      .map(Number)
      .every((value) => Number.isFinite(value) && Math.abs(value) < 0.0005))
    .toBeTruthy();
  expect(await readGestureSequence(responseControl)).toBe(initialSequence + 1);
}

async function readGestureSequence(responseControl: ReturnType<Page["locator"]>) {
  const sequence = Number(await responseControl.getAttribute("data-avatar-gesture-sequence"));
  expect(Number.isInteger(sequence) && sequence >= 0).toBeTruthy();
  return sequence;
}

async function readFallbackVisualState(fallback: ReturnType<Page["locator"]>) {
  return fallback.evaluate((element) => JSON.stringify(
    [element, ...element.querySelectorAll("*")].map((candidate) => {
      const style = window.getComputedStyle(candidate);
      return [style.animationName, style.filter, style.transform];
    }),
  ));
}

async function dispatchGazePointer(
  target: ReturnType<Page["locator"]>,
  relativeX: number,
  relativeY: number,
  pointerType: "mouse" | "touch",
) {
  await dispatchGazePointerEvent(target, "pointermove", relativeX, relativeY, pointerType);
}

async function dispatchGazePointerEvent(
  target: ReturnType<Page["locator"]>,
  type: "pointercancel" | "pointerdown" | "pointerleave" | "pointermove" | "pointerup",
  relativeX: number,
  relativeY: number,
  pointerType: "mouse" | "touch",
) {
  await target.evaluate((element, pointer) => {
    const bounds = element.getBoundingClientRect();
    const contactActive = pointer.eventType === "pointerdown"
      || (pointer.eventType === "pointermove" && pointer.type === "touch");
    element.dispatchEvent(new PointerEvent(pointer.eventType, {
      bubbles: true,
      buttons: contactActive ? 1 : 0,
      clientX: bounds.left + bounds.width * pointer.x,
      clientY: bounds.top + bounds.height * pointer.y,
      isPrimary: true,
      pointerId: pointer.type === "touch" ? 7 : 1,
      pointerType: pointer.type,
      pressure: contactActive ? 0.5 : 0,
    }));
  }, { eventType: type, x: relativeX, y: relativeY, type: pointerType });
}

async function movePointerOutside(
  page: Page,
  target: ReturnType<Page["locator"]>,
) {
  const bounds = await target.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  const corners = [
    { x: 1, y: 1 },
    { x: (viewport?.width ?? 2) - 1, y: 1 },
    { x: 1, y: (viewport?.height ?? 2) - 1 },
    { x: (viewport?.width ?? 2) - 1, y: (viewport?.height ?? 2) - 1 },
  ];
  const outside = corners.find(({ x, y }) => (
    !bounds
    || x < bounds.x
    || x > bounds.x + bounds.width
    || y < bounds.y
    || y > bounds.y + bounds.height
  ));
  expect(outside).toBeTruthy();
  await target.hover();
  await page.mouse.move(outside?.x ?? 1, outside?.y ?? 1);
}

async function readNumericTelemetry(
  target: ReturnType<Page["locator"]>,
  attribute: string,
  expectedLength: number,
) {
  const values = (await target.getAttribute(attribute))?.split(",").map(Number) ?? [];
  return values.length === expectedLength && values.every(Number.isFinite) ? values : null;
}

async function waitForChangedTelemetry(
  target: ReturnType<Page["locator"]>,
  attribute: string,
  baseline: number[] | null,
  expectedLength: number,
) {
  expect(baseline).not.toBeNull();
  let changed: number[] | null = null;
  await expect.poll(async () => {
    const current = await readNumericTelemetry(target, attribute, expectedLength);
    if (current && vectorDistance(current, baseline ?? []) > 0.001) {
      changed = current;
      return true;
    }
    return false;
  }).toBeTruthy();
  expect(changed).not.toBeNull();
  return changed as unknown as number[];
}

function vectorDifference(left: number[], right: number[]) {
  return left.map((value, index) => value - (right[index] ?? Number.NaN));
}

function vectorDistance(left: number[], right: number[]) {
  return Math.hypot(...vectorDifference(left, right));
}

async function installStaticGazeRecorder(
  canvas: ReturnType<Page["locator"]>,
  stableSample: number[],
  stableOutput: number[],
) {
  await canvas.evaluate((element, stable) => {
    let samples = 0;
    const inspect = () => {
      samples += 1;
      element.setAttribute("data-e2e-static-gaze-sample-count", String(samples));
      const parse = (attribute: string) => (
        element.getAttribute(attribute)?.split(",").map(Number) ?? []
      );
      const differs = (left: number[], right: number[]) => left.length !== right.length
        || left.some((value, index) => !Number.isFinite(value) || Math.abs(value - right[index]) > 0.000001);
      if (
        differs(parse("data-avatar-gaze-sample"), stable.sample)
        || differs(parse("data-avatar-gaze-output"), stable.output)
      ) {
        element.setAttribute("data-e2e-static-gaze-violation", "true");
      }
    };
    element.setAttribute("data-e2e-static-gaze-violation", "false");
    new MutationObserver(inspect).observe(element, {
      attributes: true,
      attributeFilter: ["data-avatar-gaze-output", "data-avatar-gaze-sample"],
    });
    inspect();
  }, { sample: stableSample, output: stableOutput });
}

async function readComputedTranslate(eye: ReturnType<Page["locator"]>) {
  return eye.evaluate((element) => {
    const translate = window.getComputedStyle(element).translate;
    if (!translate || translate === "none") {
      return [0, 0];
    }
    const values = translate.split(/\s+/).slice(0, 2).map(Number.parseFloat);
    const normalized = [values[0], values[1] ?? 0];
    return normalized.every(Number.isFinite) ? normalized : [Number.NaN, Number.NaN];
  });
}

async function waitForNonZeroTranslate(eye: ReturnType<Page["locator"]>) {
  let result = [0, 0];
  await expect.poll(async () => {
    result = await readComputedTranslate(eye);
    return Math.hypot(...result);
  }).toBeGreaterThan(0.1);
  return result;
}

async function waitForChangedTranslate(
  eye: ReturnType<Page["locator"]>,
  baseline: number[],
) {
  let result = baseline;
  await expect.poll(async () => {
    result = await readComputedTranslate(eye);
    return vectorDistance(result, baseline);
  }).toBeGreaterThan(0.1);
  return result;
}

async function installStaticFallbackGazeRecorder(
  responseControl: ReturnType<Page["locator"]>,
  eye: ReturnType<Page["locator"]>,
  stableTranslate: number[],
) {
  const eyeHandle = await eye.elementHandle();
  expect(eyeHandle).not.toBeNull();
  await responseControl.evaluate((element, recorder) => {
    let samples = 0;
    const inspect = () => {
      samples += 1;
      element.setAttribute("data-e2e-static-fallback-gaze-count", String(samples));
      const translate = window.getComputedStyle(recorder.eye).translate;
      const values = !translate || translate === "none"
        ? [0, 0]
        : translate.split(/\s+/).slice(0, 2).map(Number.parseFloat);
      const current = [values[0], values[1] ?? 0];
      if (
        current.length !== recorder.stable.length
        || current.some((value, index) => (
          !Number.isFinite(value) || Math.abs(value - recorder.stable[index]) > 0.000001
        ))
      ) {
        element.setAttribute("data-e2e-static-fallback-gaze-violation", "true");
      }
    };
    element.setAttribute("data-e2e-static-fallback-gaze-violation", "false");
    new MutationObserver(inspect).observe(element, {
      attributes: true,
      attributeFilter: ["data-avatar-gaze-input", "data-avatar-gaze-source", "style"],
    });
    inspect();
  }, { eye: eyeHandle, stable: stableTranslate });
}

async function dispatchSyntheticRealtimeState(
  page: Page,
  state: "idle" | "thinking",
) {
  await page.evaluate((nextState) => {
    const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
      .__e2eRealtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime WebSocket was not captured in an open state.");
    }
    const sessionId = /\/sessions\/([^/]+)\/realtime/.exec(socket.url)?.[1];
    if (!sessionId) {
      throw new Error("Realtime session id was not present in the WebSocket URL.");
    }
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "heartbeat",
        session_id: decodeURIComponent(sessionId),
        state: nextState,
        payload: {},
      }),
    }));
  }, state);
}

async function installFakeMicrophone(page: Page) {
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        if (/\/api\/v1\/sessions\/[^/]+\/realtime$/.test(socket.url)) {
          Object.assign(window, { __e2eRealtimeSocket: socket });
        }
        return socket;
      },
    });
    type AudioTrackGenerator = MediaStreamTrack;
    const Generator = (window as typeof window & {
      MediaStreamTrackGenerator?: new (options: { kind: "audio" }) => AudioTrackGenerator;
    }).MediaStreamTrackGenerator;
    if (!Generator) {
      throw new Error("WebCodecs audio track generation is unavailable in this browser.");
    }
    const generator = new Generator({ kind: "audio" });
    const stream = new MediaStream([generator]);
    Object.assign(window, {
      __e2eGetUserMediaCalls: 0,
      __e2eMicStream: stream,
    });

    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          const testWindow = window as typeof window & {
            __e2eGetUserMediaCalls?: number;
          };
          testWindow.__e2eGetUserMediaCalls = (testWindow.__e2eGetUserMediaCalls ?? 0) + 1;
          return stream;
        },
      },
    });
  });
}

async function installRejectedRealtimeSocket(page: Page, closeCode: number) {
  await page.evaluate((code) => {
    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          const testWindow = window as typeof window & {
            __e2eGetUserMediaCalls?: number;
          };
          testWindow.__e2eGetUserMediaCalls = (testWindow.__e2eGetUserMediaCalls ?? 0) + 1;
          return new MediaStream();
        },
      },
    });
    Object.assign(window, { __e2eGetUserMediaCalls: 0 });

    class RejectedRealtimeSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readonly protocol = "companion-v1";
      readyState = RejectedRealtimeSocket.CONNECTING;
      binaryType: BinaryType = "blob";
      onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
      onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
      onopen: ((this: WebSocket, event: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = RejectedRealtimeSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          window.setTimeout(() => {
            this.readyState = RejectedRealtimeSocket.CLOSED;
            const event = new CloseEvent("close", {
              code,
              reason: "Session not found",
            });
            this.onclose?.call(this as unknown as WebSocket, event);
            this.dispatchEvent(event);
          }, 0);
        }, 0);
      }

      close() {
        this.readyState = RejectedRealtimeSocket.CLOSED;
      }

      send() {}
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: RejectedRealtimeSocket as unknown as typeof WebSocket,
    });
  }, closeCode);
}

async function commitRealtimeText(page: Page, text: string) {
  await page.evaluate((message) => new Promise<void>((resolve, reject) => {
    const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
      .__e2eRealtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Realtime WebSocket was not captured in an open state."));
      return;
    }
    const sessionId = /\/sessions\/([^/]+)\/realtime/.exec(socket.url)?.[1];
    if (!sessionId) {
      reject(new Error("Realtime session id was not present in the WebSocket URL."));
      return;
    }
    const timeout = window.setTimeout(() => {
      socket.removeEventListener("message", handleMessage);
      reject(new Error("Realtime text commit did not receive an asr.final acknowledgement."));
    }, 10_000);
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      let payload: { type?: unknown; payload?: { text?: unknown } };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      if (payload.type !== "asr.final" || payload.payload?.text !== message) {
        return;
      }
      window.clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      resolve();
    };
    socket.addEventListener("message", handleMessage);
    socket.send(JSON.stringify({
      type: "user.commit",
      session_id: decodeURIComponent(sessionId),
      state: "idle",
      payload: { text: message },
    }));
  }), text);
}

async function dispatchSyntheticMockTtsBlobs(page: Page, count: number) {
  await page.evaluate(async (chunkCount) => {
    const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
      .__e2eRealtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime WebSocket was not captured in an open state.");
    }
    const sessionId = /\/sessions\/([^/]+)\/realtime/.exec(socket.url)?.[1];
    if (!sessionId) {
      throw new Error("Realtime session id was not present in the WebSocket URL.");
    }
    for (let index = 0; index < chunkCount; index += 1) {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "tts.chunk",
          session_id: decodeURIComponent(sessionId),
          state: "speaking",
          payload: { final: false, sequence: index },
        }),
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: new Blob([new Uint8Array([index, index + 1])], {
          type: "application/octet-stream",
        }),
      }));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }, count);
}

async function commitFakeVoice(page: Page) {
  await injectFakeAudio(page, 0.12, 450);
  await injectFakeAudio(page, 0, 800);
}

async function holdToTalkBelowVad(page: Page, durationMs: number) {
  const button = page.getByRole("button", { name: "按住说话" });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.focus();
  await page.keyboard.down("Space");
  await injectFakeAudio(page, 0.02, durationMs);
  const diagnostics = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __e2eMicStream?: MediaStream;
      __e2eGetUserMediaCalls?: number;
    };
    const stream = testWindow.__e2eMicStream;
    return {
      getUserMediaCalls: testWindow.__e2eGetUserMediaCalls ?? 0,
      tracks: stream?.getAudioTracks().map((track) => ({
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
      })) ?? [],
    };
  });
  await page.keyboard.up("Space");
  await injectFakeAudio(page, 0, 20);
  expect(diagnostics.getUserMediaCalls).toBe(1);
  expect(diagnostics.tracks).toEqual([
    { enabled: true, muted: false, readyState: "live" },
  ]);
}

async function injectFakeAudio(page: Page, level: number, durationMs: number) {
  await page.evaluate(async ({ frameLevel, frameDurationMs }) => {
    const testWindow = window as typeof window & {
      __companionInjectAudioFrame?: (level: number, pcm: Float32Array) => void;
    };
    const inject = testWindow.__companionInjectAudioFrame;
    if (!inject) {
      throw new Error("E2E audio injection hook is unavailable.");
    }
    const pcm = new Float32Array(960);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = Math.sin((index / 48_000) * 2 * Math.PI * 220) * frameLevel;
    }
    const deadline = performance.now() + frameDurationMs;
    do {
      inject(frameLevel, pcm);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    } while (performance.now() < deadline);
  }, { frameLevel: level, frameDurationMs: durationMs });
}

async function waitForAvatarRuntimeSteadyState(page: Page) {
  const runtime = page.locator("[data-runtime-mode]").first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });

  const canvas = page.getByLabel("VRM character canvas");
  await expect
    .poll(async () => {
      const value = await canvas.getAttribute("data-vrm-fps");
      return value && value !== "measuring" ? Number.parseFloat(value) : Number.NaN;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
}

async function getRealtimeSessionId(page: Page) {
  return page.evaluate(() => {
    const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
      .__e2eRealtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime WebSocket was not captured in an open state.");
    }
    const sessionId = /\/sessions\/([^/]+)\/realtime/.exec(socket.url)?.[1];
    if (!sessionId) {
      throw new Error("Realtime session id was not present in the WebSocket URL.");
    }
    return decodeURIComponent(sessionId);
  });
}

async function waitForPersistedLocalMetricValue(
  page: Page,
  eventName: "first_audio_latency_ms",
  sessionId: string,
  ownerToken: string,
) {
  const response = await page.waitForResponse((candidate) => {
    const request = candidate.request();
    if (
      request.method() !== "POST" ||
      !request.url().endsWith("/api/v1/metrics/local/signals")
    ) {
      return false;
    }
    try {
      const payload = request.postDataJSON() as {
        event?: unknown;
        session_id?: unknown;
      };
      return payload.event === eventName && payload.session_id === sessionId;
    } catch {
      return false;
    }
  }, { timeout: 20_000 });
  expect(response.status()).toBe(204);

  const payload = response.request().postDataJSON() as { value?: unknown };
  expect(typeof payload.value).toBe("number");
  const value = payload.value as number;

  const persistedResponse = await page.request.get(
    `${apiBaseUrl}/api/v1/metrics/local/events?limit=100`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  expect(persistedResponse.ok()).toBeTruthy();
  const persistedPayload = await persistedResponse.json() as {
    items?: Array<{
      event?: unknown;
      payload?: Record<string, unknown>;
    }>;
  };
  const persistedEvent = persistedPayload.items?.find((item) =>
    item.event === eventName &&
    item.payload?.session_id === sessionId &&
    item.payload?.value === value
  );
  expect(persistedEvent).toBeDefined();
  return value;
}

async function expectRealtimeReply(page: Page, userText: string) {
  await expect(page.getByText(userText)).toBeVisible({
    timeout: 20_000,
  });
  const assistantTurn = page.locator('[data-role="assistant"]').last();
  await expect(assistantTurn).toContainText("模拟回复", { timeout: 20_000 });
}

async function waitForPlayback(page: Page) {
  const playbackMeter = page.locator("[data-playback-level]").first();
  await expect
    .poll(async () => {
      const level = await playbackMeter.getAttribute("data-playback-level");
      return level ? Number.parseFloat(level) : 0;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  return playbackMeter;
}

async function initializeAndUnlockVault(page: Page) {
  await page.goto("/vault");

  const statusLabels = page.locator(".status-badge");
  await expect(page.getByRole("form", { name: /^Vault (初始化|解锁)$/ })).toHaveCount(1);
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.ok()).toBeTruthy();
  const vaultStatus = await statusResponse.json() as { initialized?: unknown };
  let ownerToken: string | null;

  if (vaultStatus.initialized !== true) {
    await page.getByLabel("初始化主密码").fill(vaultPassword);
    const initResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/init") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "初始化 Vault" }).click();
    const response = await initResponse;
    expect(response.ok()).toBeTruthy();
    ownerToken = ((await response.json()) as { owner_token?: string | null }).owner_token ?? null;
  } else {
    await page.getByLabel("解锁主密码").fill(vaultPassword);
    const unlockResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/unlock") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "解锁" }).click();
    const response = await unlockResponse;
    expect(response.ok()).toBeTruthy();
    ownerToken = ((await response.json()) as { owner_token?: string | null }).owner_token ?? null;
  }

  await expect(statusLabels.filter({ hasText: "Yes" })).toHaveCount(2, { timeout: 10_000 });
  expect(ownerToken).toBeTruthy();
  return ownerToken as string;
}

async function installFakeBuiltInVoices(page: Page) {
  await page.evaluate(() => {
    type SpokenVoice = {
      lang: string;
      pitch: number;
      rate: number;
      text: string;
      voiceURI: string | null;
    };
    type SpeechProbe = {
      availableVoices: SpeechSynthesisVoice[];
      cancelCount: number;
      current: SpeechSynthesisUtterance | null;
      forcedEmotion: "concerned" | null;
      holdOpen: boolean;
      pcmStarts: number;
      serverFinalCount: number;
      spoken: SpokenVoice[];
      voiceReadCount: number;
      voicesReady: boolean;
    };

    const voices = [
      { default: true, lang: "zh-CN", localService: true, name: "Microsoft Yaoyao Desktop", voiceURI: "e2e-genki" },
      { default: false, lang: "zh-CN", localService: true, name: "Microsoft Kangkang Desktop", voiceURI: "e2e-sweet" },
      { default: false, lang: "zh-CN", localService: true, name: "Microsoft Huihui Desktop", voiceURI: "e2e-soft" },
    ] as SpeechSynthesisVoice[];
    const probe: SpeechProbe = {
      availableVoices: voices,
      cancelCount: 0,
      current: null,
      forcedEmotion: null,
      holdOpen: false,
      pcmStarts: 0,
      serverFinalCount: 0,
      spoken: [],
      voiceReadCount: 0,
      voicesReady: true,
    };

    class FakeSpeechSynthesisUtterance extends EventTarget {
      lang = "";
      onboundary: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      onend: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      onerror: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisErrorEvent) => unknown) | null = null;
      onmark: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      onpause: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      onresume: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      onstart: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
      pitch = 1;
      rate = 1;
      text: string;
      voice: SpeechSynthesisVoice | null = null;
      volume = 1;

      constructor(text = "") {
        super();
        this.text = text;
      }
    }

    const synthesis = Object.assign(new EventTarget(), {
      cancel() {
        probe.cancelCount += 1;
        const current = probe.current;
        probe.current = null;
        if (current) {
          window.setTimeout(() => {
            current.onerror?.call(current, { error: "canceled" } as SpeechSynthesisErrorEvent);
          }, 10);
        }
      },
      getVoices() {
        probe.voiceReadCount += 1;
        return probe.voicesReady ? probe.availableVoices : [];
      },
      onvoiceschanged: null,
      pause() {},
      paused: false,
      pending: false,
      resume() {},
      speak(utterance: SpeechSynthesisUtterance) {
        probe.current = utterance;
        probe.spoken.push({
          lang: utterance.lang,
          pitch: utterance.pitch,
          rate: utterance.rate,
          text: utterance.text,
          voiceURI: utterance.voice?.voiceURI ?? null,
        });
        window.setTimeout(() => {
          if (probe.current === utterance) {
            utterance.onstart?.call(utterance, new Event("start") as SpeechSynthesisEvent);
          }
        }, 20);
        window.setTimeout(() => {
          if (probe.current === utterance && !probe.holdOpen) {
            probe.current = null;
            utterance.onend?.call(utterance, new Event("end") as SpeechSynthesisEvent);
          }
        }, 180);
      },
      speaking: false,
    }) as SpeechSynthesis;

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const payload = JSON.parse(event.data) as {
              type?: unknown;
              payload?: { emotion?: unknown; final?: unknown };
            };
            if (
              payload.type === "llm.final" &&
              payload.payload &&
              probe.forcedEmotion
            ) {
              const emotion = probe.forcedEmotion;
              probe.forcedEmotion = null;
              payload.payload.emotion = emotion;
              event.stopImmediatePropagation();
              window.queueMicrotask(() => socket.dispatchEvent(new MessageEvent("message", {
                data: JSON.stringify(payload),
              })));
              return;
            }
            if (payload.type === "tts.chunk" && payload.payload?.final === true) {
              probe.serverFinalCount += 1;
            }
          } catch {
            // The application validates malformed realtime messages separately.
          }
        });
        return socket;
      },
    });

    const audioContext = window.AudioContext;
    if (audioContext) {
      const originalCreateBufferSource = audioContext.prototype.createBufferSource;
      audioContext.prototype.createBufferSource = function createBufferSource() {
        const source = originalCreateBufferSource.call(this);
        const originalStart = source.start.bind(source);
        source.start = (...args: Parameters<AudioBufferSourceNode["start"]>) => {
          probe.pcmStarts += 1;
          return originalStart(...args);
        };
        return source;
      };
    }

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: synthesis,
    });
    Object.assign(window, { __e2eBuiltInVoice: probe });
  });
}

async function importBlobMotionCharacter(
  request: APIRequestContext,
  ownerToken: string,
) {
  const recipe = {
    ...defaultRecipe,
    motions: {
      idle: "motions/idle.vrma",
    },
  };
  const archive = makeStoredZip([
    ["character.json", JSON.stringify({
      description: "E2E manifest-authorized Blob motion",
      name: "Blob Motion Character",
    })],
    ["recipe.json", JSON.stringify(recipe)],
    ["asset_manifest.json", JSON.stringify({
      asset_paths: ["LICENSE.txt", "motions/idle.vrma"],
      license: "CC0-1.0",
      license_path: "LICENSE.txt",
      redistribution_allowed: "yes",
    })],
    ["assets/LICENSE.txt", "CC0 1.0 Universal"],
    [
      "assets/motions/idle.vrma",
      readFileSync("apps/web/public/assets/characters/motions/companion-idle.vrma"),
    ],
  ]);
  const response = await request.post(`${apiBaseUrl}/api/v1/characters/import`, {
    data: archive,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/zip",
      "X-Filename": "blob-motion-character.zip",
    },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { id?: string };
  expect(payload.id).toBeTruthy();
  return payload.id as string;
}

function makeStoredZip(files: Array<[string, Buffer | string]>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [filename, content] of files) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createRealtimeFixture(
  request: APIRequestContext,
  token: string,
  options: {
    characterId?: string;
    recipe?: Record<string, unknown>;
  } = {},
): Promise<RealtimeFixture> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const spacePayload = await postJson(request, "/api/v1/spaces", token, {
    name: `Realtime 空间 ${runId}`,
    topic: "E2E 实时防护",
    goal: "验证实时头像、权限拒绝和打断护栏",
  });
  const characterPayload = options.characterId
    ? { id: options.characterId }
    : await postJson(request, "/api/v1/characters", token, {
        name: `Realtime Nova ${runId}`,
        description: "E2E realtime guardrails character",
        recipe: options.recipe ?? defaultRecipe,
      });

  await putJson(request, `/api/v1/spaces/${spacePayload.id}/default-character`, token, {
    character_pack_id: characterPayload.id,
  });
  await postJson(request, `/api/v1/spaces/${spacePayload.id}/assignments`, token, {
    capability: "stt",
    provider_connection_id: "builtin-mock",
    model_name: "mock-stt-v1",
  });
  await postJson(request, `/api/v1/spaces/${spacePayload.id}/assignments`, token, {
    capability: "tts",
    provider_connection_id: "builtin-mock",
    model_name: "mock-voice-v1",
  });

  return {
    spaceId: spacePayload.id,
    characterId: characterPayload.id,
    callPath: `/spaces/${spacePayload.id}/call`,
    spaceName: spacePayload.name,
  };
}

async function openCallPage(page: Page, fixture: RealtimeFixture) {
  const mobileViewport = (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 760;
  const spacesLink = page.getByRole("link", {
    name: mobileViewport ? "空间" : "学习空间",
    exact: true,
  }).first();
  await Promise.all([
    page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
    spacesLink.click(),
  ]);

  const spaceCard = page.locator("article.info-card").filter({
    hasText: fixture.spaceName,
  });
  await expect(spaceCard).toBeVisible({ timeout: 20_000 });
  const spaceDetailLink = spaceCard.getByRole("link", {
    name: /^(查看主题档案|进入主题)$/,
  }).first();
  await Promise.all([
    page.waitForURL(new RegExp(`/spaces/${fixture.spaceId}$`), { timeout: 20_000 }),
    spaceDetailLink.click(),
  ]);
  await Promise.all([
    page.waitForURL(fixture.callPath, {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    }),
    page.getByRole("link", { name: "开始伴学会话" }).click(),
  ]);
}

async function routeSpaceTtsAsNonBuiltIn(
  page: Page,
  spaceId: string,
  connectionId = "real-provider-with-mock-model-name",
  modelName?: string,
) {
  await page.route(`**/api/v1/spaces/${spaceId}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as {
      assignments?: Array<{
        capability?: unknown;
        model_name?: unknown;
        provider_connection_id?: unknown;
      }>;
    };
    for (const assignment of payload.assignments ?? []) {
      if (assignment.capability === "tts") {
        assignment.provider_connection_id = connectionId;
        if (modelName) {
          assignment.model_name = modelName;
        }
      }
    }
    await route.fulfill({ response, json: payload });
  });
}

async function postJson(
  request: APIRequestContext,
  path: string,
  ownerToken: string,
  payload: unknown,
) {
  const response = await request.post(`${apiBaseUrl}${path}`, {
    data: payload,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function putJson(
  request: APIRequestContext,
  path: string,
  ownerToken: string,
  payload: unknown,
) {
  const response = await request.put(`${apiBaseUrl}${path}`, {
    data: payload,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function sendTextAndExpectAssistantReply(page: Page, message: string) {
  const composer = page.getByLabel("发送文字消息");
  await composer.fill(message);
  await page.getByRole("button", { name: "发送文本" }).click();

  const assistantTurn = page.locator('[data-role="assistant"]').last();
  await expect(assistantTurn).toContainText("模拟回复", { timeout: 20_000 });
}
