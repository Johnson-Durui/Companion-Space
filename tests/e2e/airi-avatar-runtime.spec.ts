import { createHash } from "node:crypto";

import { expect, test, type Page, type Request } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const vaultPassword = "m7-playwright-pass";

type DisplayFormat = "live2d-zip" | "spine-zip";
type RuntimeFormat = "live2d" | "spine";

type BridgeProbe = {
  creates: Array<{
    archivePrefix: string;
    archiveSize: number;
    entrypoint: string;
    id: string;
    initial: Record<string, unknown>;
    mountTag: string;
    sha256: string;
    signalAbortedAtCreate: boolean;
  }>;
  destroys: Record<string, number>;
  destroySignals: Record<string, boolean>;
  nextId: number;
  resizes: Array<{ devicePixelRatio: number; height: number; id: string; width: number }>;
  updates: Array<{ id: string; value: Record<string, unknown> }>;
};

for (const displayFormat of ["live2d-zip", "spine-zip"] as const) {
  const runtimeFormat = displayFormat === "live2d-zip" ? "live2d" : "spine";

  test(`imports and runs a protected ${runtimeFormat} AIRI avatar through an explicit session binding`, async ({ page }) => {
    test.setTimeout(180_000);
    await installMockBridge(page, runtimeFormat);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ownerToken = await authorizeFocusedBrowser(page);
    const runSuffix = `${Date.now().toString(36)}-${runtimeFormat}`;
    const characterName = `E2E AIRI ${runtimeFormat} ${runSuffix}`;
    const fixture = buildAiriFixture(displayFormat, characterName);
    const targetSpace = await ensureSpace(page, ownerToken, runSuffix);
    const defaultMappingsBefore = await readSpaceDefaults(page, ownerToken);
    const requests: string[] = [];
    const recordRequest = (request: Request) => requests.push(request.url());
    page.on("request", recordRequest);

    const imported = await importAiriCharacter(page, fixture.outerZip, runSuffix);
    expect(imported.asset_manifest).toMatchObject({
      entrypoint: fixture.entrypoint,
      format: displayFormat,
      model_path: "display-model/model.zip",
      render_mode: runtimeFormat,
      sha256: fixture.sha256,
      source_display_model_imported: true,
    });

    const editorRuntime = page.locator(`[data-avatar-runtime-kind="${runtimeFormat}"]`).first();
    await expect(editorRuntime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(editorRuntime).toHaveAttribute("data-runtime-reason", "ready");
    await expect(editorRuntime).toHaveAttribute("data-runtime-canvas-count", "1");
    await expect(editorRuntime.locator("canvas[data-e2e-licensed-runtime]")).toHaveCount(1);
    await expect(editorRuntime.getByTestId("avatar-fallback")).toHaveCount(0);

    const protectedAsset = await page.request.get(
      `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/display-model/model.zip`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(protectedAsset.status()).toBe(200);
    expect(protectedAsset.headers()["cache-control"]).toBe("private, no-store");
    expect(protectedAsset.headers()["content-type"]).toContain("application/zip");
    expect(Buffer.compare(await protectedAsset.body(), fixture.innerZip)).toBe(0);

    const previewState = page.getByRole("group", { name: "Preview State" });
    await previewState.getByRole("button", { name: "Thinking", exact: true }).click();
    await expect.poll(async () => (await readBridgeProbe(page)).updates.some(
      (update) => update.value.state === "thinking",
    )).toBe(true);

    await navigateToCharacterLibrary(page);
    await expect.poll(async () => {
      const probe = await readBridgeProbe(page);
      return probe.creates.length > 0
        && probe.creates.every((create) => probe.destroys[create.id] === 1);
    }).toBe(true);
    const editorCreateCount = (await readBridgeProbe(page)).creates.length;

    await page.goto(`/spaces/${targetSpace.id}/call`);
    const sessionCharacter = page.getByLabel("本次会话角色", { exact: true });
    await expect(sessionCharacter).toBeEnabled();
    await expect(sessionCharacter).toHaveValue("");
    await expect(page.locator("[data-runtime-mode]").first()).not.toHaveAttribute(
      "data-runtime-mode",
      "loading",
      { timeout: 60_000 },
    );
    requests.length = 0;
    await startRuntimeKindProbe(page);
    await sessionCharacter.selectOption(imported.id);
    const callRuntime = page.locator(`[data-avatar-runtime-kind="${runtimeFormat}"]`).first();
    await expect(callRuntime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
    await expect(callRuntime).toHaveAttribute("data-runtime-reason", "ready");
    await expect(callRuntime.locator("canvas[data-e2e-licensed-runtime]")).toHaveCount(1);
    await expect(callRuntime.getByTestId("avatar-fallback")).toHaveCount(0);

    const sessionPost = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/sessions"),
    );
    await page.getByPlaceholder(/输入消息/).fill(`验证 ${runtimeFormat} 会话绑定 ${runSuffix}`);
    await page.getByRole("button", { name: "发送文本", exact: true }).click();
    const sessionResponse = await sessionPost;
    expect(sessionResponse.status()).toBe(201);
    const session = await sessionResponse.json() as { character_pack_id: string | null; id: string };
    expect(session.character_pack_id).toBe(imported.id);
    await expect(sessionCharacter).toBeDisabled();
    await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 20_000 });

    const callProbe = await readBridgeProbe(page);
    expect(callProbe.creates.length).toBeGreaterThan(editorCreateCount);
    for (const create of callProbe.creates) {
      expect(create).toMatchObject({
        archivePrefix: "PK",
        entrypoint: fixture.entrypoint,
        mountTag: "DIV",
        sha256: fixture.sha256,
        signalAbortedAtCreate: false,
      });
      expect(create.archiveSize).toBe(fixture.innerZip.length);
      expect(create.initial).toEqual({
        emotion: "neutral",
        reducedMotion: true,
        speechLevel: 0,
        state: "idle",
      });
    }
    expect(callProbe.resizes.some(({ width, height, devicePixelRatio }) =>
      width > 0 && height > 0 && devicePixelRatio > 0
    )).toBe(true);
    expect(callProbe.updates.some(({ value }) =>
      typeof value.state === "string"
      && typeof value.emotion === "string"
      && value.reducedMotion === true
    )).toBe(true);
    expect(await readSpaceDefaults(page, ownerToken)).toEqual(defaultMappingsBefore);
    expect(requests.some((url) =>
      new URL(url).pathname === `/api/v1/characters/${imported.id}/assets/display-model/model.zip`
    )).toBe(true);
    expect(requests.some((url) => /\.vrm(?:\?|$)/i.test(url))).toBe(false);
    const callRuntimeKinds = await readRuntimeKindProbe(page);
    expect(callRuntimeKinds).not.toContain("vrm");
    expect(callRuntimeKinds).not.toContain("fallback");
    page.off("request", recordRequest);

    await navigateToCharacterLibrary(page);
    await expect.poll(async () => {
      const probe = await readBridgeProbe(page);
      return probe.creates.length > 0
        && probe.creates.every((create) => probe.destroys[create.id] === 1);
    }).toBe(true);
    const probe = await readBridgeProbe(page);
    expect(probe.creates).toHaveLength(callProbe.creates.length);
    for (const create of probe.creates) {
      expect(probe.destroySignals[create.id]).toBe(true);
    }
  });
}

test("hydrates a licensed Live2D session without exposing VRM or fallback", async ({ page }) => {
  test.setTimeout(180_000);
  await installMockBridge(page, "live2d");
  const ownerToken = await authorizeFocusedBrowser(page);
  const runSuffix = `${Date.now().toString(36)}-licensed-resume`;
  const characterName = `E2E licensed resume ${runSuffix}`;
  const fixture = buildAiriFixture("live2d-zip", characterName);
  const space = await createIsolatedSpace(page, ownerToken, runSuffix);
  const imported = await importAiriCharacter(page, fixture.outerZip, runSuffix);
  const editorRuntime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(editorRuntime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  await navigateToCharacterLibrary(page);
  await expect.poll(async () => {
    const probe = await readBridgeProbe(page);
    return probe.creates.length > 0
      && probe.creates.every((create) => probe.destroys[create.id] === 1);
  }).toBe(true);

  await page.goto(`/spaces/${space.id}/call`);
  const characterSelect = page.getByLabel("本次会话角色", { exact: true });
  await expect(characterSelect).toBeEnabled();
  await characterSelect.selectOption(imported.id);
  const firstCallRuntime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(firstCallRuntime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  const sessionPost = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/sessions"),
  );
  await page.getByPlaceholder(/输入消息/).fill(`创建 licensed 恢复会话 ${runSuffix}`);
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  const sessionResponse = await sessionPost;
  expect(sessionResponse.status()).toBe(201);
  const session = await sessionResponse.json() as { character_pack_id: string | null; id: string };
  expect(session.character_pack_id).toBe(imported.id);
  await expect(characterSelect).toBeDisabled();

  await navigateToCharacterLibrary(page);
  await expect.poll(async () => {
    const probe = await readBridgeProbe(page);
    return probe.creates.length > 0
      && probe.creates.every((create) => probe.destroys[create.id] === 1);
  }).toBe(true);
  const createCountBeforeResume = (await readBridgeProbe(page)).creates.length;
  const requests: string[] = [];
  const recordRequest = (request: Request) => requests.push(request.url());
  page.on("request", recordRequest);
  await installHydrationRuntimeProbe(page);

  await page.goto(`/spaces/${space.id}/call?session=${session.id}`);
  const resumedSelect = page.getByLabel("本次会话角色", { exact: true });
  await expect(resumedSelect).toBeDisabled({ timeout: 60_000 });
  await expect(resumedSelect).toHaveValue(imported.id);
  await expect(page.getByRole("status").filter({ hasText: characterName })).toBeVisible({
    timeout: 60_000,
  });
  const resumedRuntime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(resumedRuntime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  await expect(resumedRuntime).toHaveAttribute("data-runtime-reason", "ready");
  await expect(resumedRuntime.locator("canvas[data-e2e-licensed-runtime]")).toHaveCount(1);
  const hydrationProbe = await readHydrationRuntimeProbe(page);
  expect(hydrationProbe.sawLoading).toBe(true);
  expect(hydrationProbe.violation).toBe(false);
  expect(hydrationProbe.kinds).not.toContain("vrm");
  expect(hydrationProbe.kinds).not.toContain("fallback");
  expect(requests.some((url) => /\.vrm(?:\?|$)/i.test(url))).toBe(false);
  expect((await readBridgeProbe(page)).creates.length).toBeGreaterThan(createCountBeforeResume);

  await navigateToCharacterLibrary(page);
  await expect.poll(async () => {
    const probe = await readBridgeProbe(page);
    return probe.creates.every((create) => probe.destroys[create.id] === 1);
  }).toBe(true);
  page.off("request", recordRequest);
});

test("does not report a licensed canvas ready until the bridge ready promise resolves", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const runtimeWindow = window as typeof window & {
      __readyGate?: { destroys: Record<string, number>; nextId: number };
      __resolveReadyGate?: () => void;
    };
    runtimeWindow.__readyGate = { destroys: {}, nextId: 0 };
    let resolveReady = () => undefined;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    runtimeWindow.__resolveReadyGate = resolveReady;
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      live2d: {
        protocol: "companion-avatar-runtime/v1",
        format: "live2d",
        create(input: { mount: HTMLElement }) {
          const gate = runtimeWindow.__readyGate!;
          gate.nextId += 1;
          const id = String(gate.nextId);
          const canvas = document.createElement("canvas");
          canvas.dataset.e2eReadyGate = id;
          input.mount.append(canvas);
          return {
            ready,
            update() {},
            resize() {},
            destroy() {
              gate.destroys[id] = (gate.destroys[id] ?? 0) + 1;
              canvas.remove();
            },
          };
        },
      },
    };
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("live2d-zip", `E2E ready gate ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "ready-gate");
  const runtime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(runtime.locator("canvas[data-e2e-ready-gate]")).toHaveCount(1, { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-mode", "loading");
  await expect(runtime).toHaveAttribute("data-ready", "false");
  await expect(runtime).toHaveAttribute("data-runtime-canvas-count", "0");

  await page.evaluate(() => (
    window as typeof window & { __resolveReadyGate?: () => void }
  ).__resolveReadyGate?.());
  await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "ready");
  await expect(runtime).toHaveAttribute("data-runtime-canvas-count", "1");
  await navigateToCharacterLibrary(page);
  await expect.poll(() => page.evaluate(() => {
    const gate = (
      window as typeof window & {
        __readyGate?: { destroys: Record<string, number>; nextId: number };
      }
    ).__readyGate;
    return Boolean(gate?.nextId)
      && Object.keys(gate?.destroys ?? {}).length === gate?.nextId
      && Object.values(gate?.destroys ?? {}).every((count) => count === 1);
  })).toBe(true);
  const readyGate = await page.evaluate(() => (
    window as typeof window & {
      __readyGate?: { destroys: Record<string, number>; nextId: number };
    }
  ).__readyGate);
  expect(readyGate).toEqual({ destroys: { "1": 1 }, nextId: 1 });
});

test("contains a licensed runtime ready rejection and destroys its canvas once", async ({ page }) => {
  await page.addInitScript(() => {
    const runtimeWindow = window as typeof window & {
      __readyReject?: { destroys: Record<string, number>; nextId: number };
    };
    runtimeWindow.__readyReject = { destroys: {}, nextId: 0 };
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      live2d: {
        protocol: "companion-avatar-runtime/v1",
        format: "live2d",
        create(input: { mount: HTMLElement }) {
          const probe = runtimeWindow.__readyReject!;
          probe.nextId += 1;
          const id = String(probe.nextId);
          const canvas = document.createElement("canvas");
          input.mount.append(canvas);
          return {
            ready: Promise.reject(new Error("mock first frame failed")),
            update() {},
            resize() {},
            destroy() {
              probe.destroys[id] = (probe.destroys[id] ?? 0) + 1;
              canvas.remove();
            },
          };
        },
      },
    };
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("live2d-zip", `E2E ready rejection ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "ready-rejection");
  const runtime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "runtime-invalid");
  await expect(runtime.getByRole("alert")).toContainText("mock first frame failed");
  await expect(runtime.locator("canvas")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __readyReject?: { destroys: Record<string, number>; nextId: number };
      }
    ).__readyReject;
    return Boolean(probe?.nextId)
      && Object.keys(probe?.destroys ?? {}).length === probe?.nextId
      && Object.values(probe?.destroys ?? {}).every((count) => count === 1);
  })).toBe(true);
  const readyReject = await page.evaluate(() => (
    window as typeof window & {
      __readyReject?: { destroys: Record<string, number>; nextId: number };
    }
  ).__readyReject);
  expect(readyReject).toEqual({ destroys: { "1": 1 }, nextId: 1 });
});

for (const fault of ["update", "resize"] as const) {
  test(`contains an asynchronous licensed runtime ${fault} rejection`, async ({ page }) => {
    test.setTimeout(120_000);
    await installAsyncFaultBridge(page, fault);
    await authorizeFocusedBrowser(page);
    const fixture = buildAiriFixture("spine-zip", `E2E async ${fault} ${Date.now()}`);
    await importAiriCharacter(page, fixture.outerZip, `async-${fault}`);
    const runtime = page.locator('[data-avatar-runtime-kind="spine"]').first();
    await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 60_000 });
    await expect(runtime).toHaveAttribute("data-runtime-reason", "runtime-invalid");
    await expect(runtime.getByRole("alert")).toContainText(`mock async ${fault} failed`);
    await expect(runtime.locator("canvas")).toHaveCount(0);
    await expect(runtime.getByTestId("avatar-fallback")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const probe = (
        window as typeof window & {
          __asyncFault?: { destroys: Record<string, number>; nextId: number };
        }
      ).__asyncFault;
      return Boolean(probe?.nextId)
        && Object.keys(probe?.destroys ?? {}).length === probe?.nextId
        && Object.values(probe?.destroys ?? {}).every((count) => count === 1);
    })).toBe(true);
    const faultProbe = await page.evaluate(() => (
      window as typeof window & {
        __asyncFault?: { destroys: Record<string, number>; nextId: number };
      }
    ).__asyncFault);
    expect(faultProbe).toEqual({ destroys: { "1": 1 }, nextId: 1 });
    expect(await page.evaluate(() => (
      window as typeof window & { __asyncFaultUnhandled?: string[] }
    ).__asyncFaultUnhandled ?? [])).toEqual([]);
  });
}

test("blocks a tampered protected archive without changing licensed text-session binding", async ({ page }) => {
  test.setTimeout(180_000);
  const ownerToken = await authorizeFocusedBrowser(page);
  const runSuffix = `${Date.now().toString(36)}-sha-tamper`;
  const characterName = `E2E SHA tamper ${runSuffix}`;
  const fixture = buildAiriFixture("live2d-zip", characterName);
  const targetSpace = await ensureSpace(page, ownerToken, runSuffix);
  const tamperedZip = Buffer.from(fixture.innerZip);
  tamperedZip[tamperedZip.length - 1] ^= 0xff;
  await page.route("**/api/v1/characters/*/assets/display-model/model.zip", async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        Authorization: `Bearer ${ownerToken}`,
      },
    });
    expect(response.status()).toBe(200);
    await route.fulfill({ response, body: tamperedZip });
  });

  const imported = await importAiriCharacter(page, fixture.outerZip, runSuffix);
  await expect(page.getByText(/archive SHA-256 does not match its manifest/).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-licensed-runtime-mount] canvas")).toHaveCount(0);
  await expect(page.getByTestId("avatar-fallback")).toHaveCount(0);

  await page.goto(`/spaces/${targetSpace.id}/call`);
  const characterSelect = page.getByLabel("本次会话角色", { exact: true });
  await expect(characterSelect).toBeEnabled();
  await expect(page.locator("[data-runtime-mode]").first()).not.toHaveAttribute(
    "data-runtime-mode",
    "loading",
    { timeout: 60_000 },
  );
  const requests: string[] = [];
  const recordRequest = (request: Request) => requests.push(request.url());
  page.on("request", recordRequest);
  await startRuntimeKindProbe(page);
  await characterSelect.selectOption(imported.id);
  await expect(page.getByRole("status").filter({ hasText: characterName })).toBeVisible({
    timeout: 60_000,
  });
  const blockedRuntime = page.locator('[data-avatar-runtime-kind="character"]').first();
  await expect(blockedRuntime).toHaveAttribute("data-runtime-mode", "blocked", { timeout: 60_000 });
  await expect(blockedRuntime).toHaveAttribute("data-runtime-reason", "character-asset-invalid");
  await expect(blockedRuntime.getByRole("alert")).toContainText(
    "archive SHA-256 does not match its manifest",
  );
  await expect(blockedRuntime.locator("canvas")).toHaveCount(0);
  await expect(blockedRuntime.getByTestId("avatar-fallback")).toHaveCount(0);

  const sessionPost = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/sessions"),
  );
  await page.getByPlaceholder(/输入消息/).fill(`SHA 失败仍绑定文字会话 ${runSuffix}`);
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  const sessionResponse = await sessionPost;
  expect(sessionResponse.status()).toBe(201);
  expect((await sessionResponse.json() as { character_pack_id: string | null }).character_pack_id)
    .toBe(imported.id);
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 20_000 });
  expect(requests.some((url) => /\.vrm(?:\?|$)/i.test(url))).toBe(false);
  expect(await readRuntimeKindProbe(page)).not.toContain("vrm");
  page.off("request", recordRequest);
});

test("loads a same-origin licensed runtime bridge as an actual ES module", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.__COMPANION_AVATAR_RUNTIME_BRIDGE_URLS__ = {
      live2d: "/e2e/licensed-live2d-bridge.mjs",
    };
  });
  let moduleRequests = 0;
  await page.route("**/e2e/licensed-live2d-bridge.mjs", async (route) => {
    moduleRequests += 1;
    await route.fulfill({
      contentType: "text/javascript",
      body: `
        export default {
          protocol: "companion-avatar-runtime/v1",
          format: "live2d",
          create({ mount }) {
            const canvas = document.createElement("canvas");
            canvas.dataset.e2eDynamicModule = "ready";
            mount.append(canvas);
            return {
              ready: Promise.resolve(),
              update() {},
              resize() {},
              destroy() { canvas.remove(); },
            };
          },
        };
      `,
    });
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("live2d-zip", `E2E dynamic module ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "dynamic-module");
  const runtime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "ready");
  await expect(runtime.locator('canvas[data-e2e-dynamic-module="ready"]')).toHaveCount(1);
  expect(moduleRequests).toBe(1);
});

test("blocks a cross-origin licensed runtime bridge URL before requesting it", async ({ page }) => {
  await page.addInitScript(() => {
    window.__COMPANION_AVATAR_RUNTIME_BRIDGE_URLS__ = {
      spine: "https://runtime.invalid/e2e-spine-bridge.mjs",
    };
  });
  let externalRequests = 0;
  page.on("request", (request) => {
    if (request.url().startsWith("https://runtime.invalid/")) {
      externalRequests += 1;
    }
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("spine-zip", `E2E cross origin ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "cross-origin");
  const runtime = page.locator('[data-avatar-runtime-kind="spine"]').first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "blocked", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "cross-origin");
  await expect(runtime.getByRole("alert")).toContainText("必须与 Companion Space 同源");
  await expect(runtime.locator("canvas")).toHaveCount(0);
  await expect(runtime.getByTestId("avatar-fallback")).toHaveCount(0);
  expect(externalRequests).toBe(0);
});

test("treats a same-SHA licensed archive from another character as a new loading instance", async ({ page }) => {
  test.setTimeout(180_000);
  await installSameShaReadyGate(page);
  const ownerToken = await authorizeFocusedBrowser(page);
  const runSuffix = `${Date.now().toString(36)}-same-sha`;
  const firstName = `E2E same SHA first ${runSuffix}`;
  const secondName = `E2E same SHA second ${runSuffix}`;
  const firstFixture = buildAiriFixture("live2d-zip", firstName);
  const secondFixture = buildAiriFixture("live2d-zip", secondName);
  expect(secondFixture.sha256).toBe(firstFixture.sha256);
  expect(Buffer.compare(secondFixture.innerZip, firstFixture.innerZip)).toBe(0);
  const first = await importAiriCharacter(page, firstFixture.outerZip, `${runSuffix}-first`);
  const second = await importAiriCharacter(page, secondFixture.outerZip, `${runSuffix}-second`);
  const space = await createIsolatedSpace(page, ownerToken, runSuffix);

  await page.goto(`/spaces/${space.id}/call`);
  const characterSelect = page.getByLabel("本次会话角色", { exact: true });
  await expect(characterSelect).toBeEnabled();
  await page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __sameShaGate?: { count: number; destroys: Record<string, number>; resolvers: Array<() => void> };
    };
    runtimeWindow.__sameShaGate = { count: 0, destroys: {}, resolvers: [] };
  });

  await characterSelect.selectOption(first.id);
  const runtime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  const visibleCanvas = runtime.locator("canvas[data-e2e-same-sha-instance]");
  await expect(visibleCanvas).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(visibleCanvas).toHaveAttribute("data-e2e-same-sha-instance", "1");
  await expect(runtime).toHaveAttribute("data-runtime-mode", "loading");
  await resolveSameShaGate(page, 1);
  await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });

  await installSameShaStickyLoadingProbe(page);
  await characterSelect.selectOption(second.id);
  expect(await readSameShaStickyViolation(page)).toBe(false);
  await expect(page.getByRole("status").filter({ hasText: secondName })).toBeVisible({
    timeout: 60_000,
  });
  await expect(visibleCanvas).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(() => visibleCanvas.getAttribute("data-e2e-same-sha-instance"), {
    timeout: 60_000,
  }).toBe("2");
  expect(await readSameShaStickyViolation(page)).toBe(false);
  await expect(runtime).toHaveAttribute("data-runtime-mode", "loading");
  await expect(runtime).toHaveAttribute("data-ready", "false");
  expect(await readSameShaStickyViolation(page)).toBe(false);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __sameShaGate?: { destroys: Record<string, number> };
    }
  ).__sameShaGate?.destroys["1"] ?? 0)).toBe(1);
  expect(await readSameShaStickyViolation(page)).toBe(false);

  await resolveSameShaGate(page, 2);
  await expect(runtime).toHaveAttribute("data-runtime-mode", "ready", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "ready");
  await navigateToCharacterLibrary(page);
  await expect.poll(() => page.evaluate(() => {
    const gate = (
      window as typeof window & {
        __sameShaGate?: { count: number; destroys: Record<string, number> };
      }
    ).__sameShaGate;
    return Boolean(gate?.count)
      && Object.keys(gate?.destroys ?? {}).length === gate?.count
      && Object.values(gate?.destroys ?? {}).every((count) => count === 1);
  })).toBe(true);
  const finalGate = await page.evaluate(() => {
    const gate = (
      window as typeof window & {
        __sameShaGate?: { count: number; destroys: Record<string, number> };
      }
    ).__sameShaGate;
    return gate ? { count: gate.count, destroys: gate.destroys } : null;
  });
  expect(finalGate).toEqual({ count: 2, destroys: { "1": 1, "2": 1 } });
});

test("keeps an imported Live2D avatar blocked without a licensed bridge while text chat remains usable", async ({ page }) => {
  test.setTimeout(150_000);
  const ownerToken = await authorizeFocusedBrowser(page);
  const runSuffix = `${Date.now().toString(36)}-blocked`;
  const fixture = buildAiriFixture("live2d-zip", `E2E AIRI blocked ${runSuffix}`);
  const targetSpace = await ensureSpace(page, ownerToken, runSuffix);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  const imported = await importAiriCharacter(page, fixture.outerZip, runSuffix);
  const editorRuntime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(editorRuntime).toHaveAttribute("data-runtime-mode", "blocked", { timeout: 60_000 });
  await expect(editorRuntime).toHaveAttribute("data-runtime-reason", "bridge-unconfigured");
  await expect(editorRuntime.getByRole("alert")).toContainText("尚未配置同源的已许可运行时桥接");
  await expect(editorRuntime).toHaveAttribute("data-runtime-canvas-count", "0");
  await expect(editorRuntime.locator("canvas")).toHaveCount(0);
  await expect(editorRuntime.getByTestId("avatar-fallback")).toHaveCount(0);

  await page.goto(`/spaces/${targetSpace.id}/call`);
  await page.getByLabel("本次会话角色", { exact: true }).selectOption(imported.id);
  const callRuntime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(callRuntime).toHaveAttribute("data-runtime-mode", "blocked", { timeout: 60_000 });
  await expect(callRuntime).toHaveAttribute("data-runtime-reason", "bridge-unconfigured");
  await expect(callRuntime.getByRole("alert")).toContainText("尚未配置同源的已许可运行时桥接");
  await expect(callRuntime.locator("canvas")).toHaveCount(0);
  await page.getByPlaceholder(/输入消息/).fill(`无桥接仍发送文字 ${runSuffix}`);
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 20_000 });
  expect(requests.some((url) =>
    url.includes(`/api/v1/characters/${imported.id}/assets/`)
    && /\.vrm(?:\?|$)/i.test(url)
  )).toBe(false);
});

test("blocks a Live2D bridge with the wrong protocol before create", async ({ page }) => {
  await page.addInitScript(() => {
    const globalWindow = window as typeof window & { __wrongProtocolCreateCalls?: number };
    globalWindow.__wrongProtocolCreateCalls = 0;
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      live2d: {
        protocol: "companion-avatar-runtime/v0",
        format: "live2d",
        create: () => { globalWindow.__wrongProtocolCreateCalls = 1; },
      },
    };
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("live2d-zip", `E2E wrong protocol ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "wrong-protocol");
  const runtime = page.locator('[data-avatar-runtime-kind="live2d"]').first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "blocked", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "protocol-mismatch");
  await expect(runtime.getByRole("alert")).toContainText("协议或格式不匹配");
  expect(await page.evaluate(() => (
    window as typeof window & { __wrongProtocolCreateCalls?: number }
  ).__wrongProtocolCreateCalls)).toBe(0);
  await expect(runtime.locator("canvas")).toHaveCount(0);
  await expect(runtime.getByTestId("avatar-fallback")).toHaveCount(0);
});

test("reports a licensed bridge create failure without rendering a fallback or VRM", async ({ page }) => {
  await page.addInitScript(() => {
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      spine: {
        protocol: "companion-avatar-runtime/v1",
        format: "spine",
        create: () => { throw new Error("mock licensed runtime failed"); },
      },
    };
  });
  await authorizeFocusedBrowser(page);
  const fixture = buildAiriFixture("spine-zip", `E2E bridge error ${Date.now()}`);
  await importAiriCharacter(page, fixture.outerZip, "bridge-error");
  const runtime = page.locator('[data-avatar-runtime-kind="spine"]').first();
  await expect(runtime).toHaveAttribute("data-runtime-mode", "error", { timeout: 60_000 });
  await expect(runtime).toHaveAttribute("data-runtime-reason", "load-failed");
  await expect(runtime).toHaveAttribute("data-runtime-detail", "mock licensed runtime failed");
  await expect(runtime.getByRole("alert")).toContainText("mock licensed runtime failed");
  await expect(runtime.locator("canvas")).toHaveCount(0);
  await expect(runtime.getByTestId("avatar-fallback")).toHaveCount(0);
});

async function installMockBridge(page: Page, format: RuntimeFormat) {
  await page.addInitScript((runtimeFormat) => {
    const globalWindow = window as typeof window & { __airiBridgeProbe?: BridgeProbe };
    const storageKey = "companion-e2e-airi-bridge-probe";
    let probe: BridgeProbe = {
      creates: [],
      destroys: {},
      destroySignals: {},
      nextId: 0,
      resizes: [],
      updates: [],
    };
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        probe = JSON.parse(stored) as BridgeProbe;
        probe.nextId ??= probe.creates.length;
      }
    } catch {
      // about:blank does not expose sessionStorage; the same script runs again on the app origin.
    }
    const persist = () => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(probe));
      } catch {
        // See the about:blank note above.
      }
    };
    globalWindow.__airiBridgeProbe = probe;
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      [runtimeFormat]: {
        protocol: "companion-avatar-runtime/v1",
        format: runtimeFormat,
        async create(input: {
          archive: Blob;
          entrypoint: string;
          initial: Record<string, unknown>;
          mount: HTMLElement;
          sha256: string;
          signal: AbortSignal;
        }) {
          probe.nextId += 1;
          const id = `${runtimeFormat}-${probe.nextId}`;
          persist();
          const prefix = new Uint8Array(await input.archive.slice(0, 2).arrayBuffer());
          probe.creates.push({
            archivePrefix: String.fromCharCode(...prefix),
            archiveSize: input.archive.size,
            entrypoint: input.entrypoint,
            id,
            initial: { ...input.initial },
            mountTag: input.mount.tagName,
            sha256: input.sha256,
            signalAbortedAtCreate: input.signal.aborted,
          });
          persist();
          const canvas = document.createElement("canvas");
          canvas.dataset.e2eLicensedRuntime = id;
          input.mount.append(canvas);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return {
            instanceId: id,
            ready: new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            update(value: Record<string, unknown>) {
              probe.updates.push({ id, value: { ...value } });
              persist();
              canvas.dataset.state = String(value.state ?? "");
              canvas.dataset.emotion = String(value.emotion ?? "");
              canvas.dataset.reducedMotion = String(value.reducedMotion ?? false);
            },
            resize(width: number, height: number, devicePixelRatio: number) {
              probe.resizes.push({ devicePixelRatio, height, id, width });
              persist();
            },
            destroy() {
              probe.destroys[id] = (probe.destroys[id] ?? 0) + 1;
              probe.destroySignals[id] = input.signal.aborted;
              persist();
              canvas.remove();
            },
          };
        },
      },
    };
  }, format);
}

async function installAsyncFaultBridge(page: Page, fault: "resize" | "update") {
  await page.addInitScript((faultMethod) => {
    const runtimeWindow = window as typeof window & {
      __asyncFault?: { destroys: Record<string, number>; nextId: number };
      __asyncFaultUnhandled?: string[];
    };
    runtimeWindow.__asyncFault = { destroys: {}, nextId: 0 };
    runtimeWindow.__asyncFaultUnhandled = [];
    window.addEventListener("unhandledrejection", (event) => {
      runtimeWindow.__asyncFaultUnhandled?.push(String(event.reason));
    });
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      spine: {
        protocol: "companion-avatar-runtime/v1",
        format: "spine",
        create(input: { mount: HTMLElement }) {
          const probe = runtimeWindow.__asyncFault!;
          probe.nextId += 1;
          const id = String(probe.nextId);
          const canvas = document.createElement("canvas");
          input.mount.append(canvas);
          return {
            ready: Promise.resolve(),
            update() {
              return faultMethod === "update"
                ? Promise.reject(new Error("mock async update failed"))
                : Promise.resolve();
            },
            resize() {
              return faultMethod === "resize"
                ? Promise.reject(new Error("mock async resize failed"))
                : Promise.resolve();
            },
            destroy() {
              probe.destroys[id] = (probe.destroys[id] ?? 0) + 1;
              canvas.remove();
            },
          };
        },
      },
    };
  }, fault);
}

async function installSameShaReadyGate(page: Page) {
  await page.addInitScript(() => {
    const runtimeWindow = window as typeof window & {
      __sameShaGate?: {
        count: number;
        destroys: Record<string, number>;
        resolvers: Array<() => void>;
      };
    };
    runtimeWindow.__sameShaGate = { count: 0, destroys: {}, resolvers: [] };
    window.__COMPANION_AVATAR_RUNTIME_BRIDGES__ = {
      live2d: {
        protocol: "companion-avatar-runtime/v1",
        format: "live2d",
        create(input: { mount: HTMLElement }) {
          const gate = runtimeWindow.__sameShaGate!;
          const id = String(gate.count + 1);
          gate.count += 1;
          const canvas = document.createElement("canvas");
          canvas.dataset.e2eSameShaInstance = id;
          input.mount.append(canvas);
          let resolveReady = () => undefined;
          const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
          gate.resolvers.push(resolveReady);
          return {
            ready,
            update() {},
            resize() {},
            destroy() {
              gate.destroys[id] = (gate.destroys[id] ?? 0) + 1;
              canvas.remove();
            },
          };
        },
      },
    };
  });
}

async function resolveSameShaGate(page: Page, instance: number) {
  await page.evaluate((index) => {
    const runtimeWindow = window as typeof window & {
      __sameShaGate?: { resolvers: Array<() => void> };
      __sameShaStickyProbe?: { gateResolved: boolean };
    };
    if (runtimeWindow.__sameShaStickyProbe) {
      runtimeWindow.__sameShaStickyProbe.gateResolved = true;
    }
    runtimeWindow.__sameShaGate?.resolvers[index - 1]?.();
  }, instance);
}

async function installSameShaStickyLoadingProbe(page: Page) {
  await page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __sameShaStickyObserver?: MutationObserver;
      __sameShaStickyProbe?: { gateResolved: boolean; violation: boolean };
    };
    runtimeWindow.__sameShaStickyObserver?.disconnect();
    const probe = { gateResolved: false, violation: false };
    const inspect = () => {
      if (probe.gateResolved) {
        return;
      }
      const runtime = document.querySelector<HTMLElement>("[data-avatar-runtime-kind]");
      if (runtime?.dataset.runtimeMode === "ready" || runtime?.dataset.ready === "true") {
        probe.violation = true;
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-avatar-runtime-kind", "data-ready", "data-runtime-mode"],
      childList: true,
      subtree: true,
    });
    runtimeWindow.__sameShaStickyProbe = probe;
    runtimeWindow.__sameShaStickyObserver = observer;
  });
}

async function readSameShaStickyViolation(page: Page) {
  return page.evaluate(() => (
    window as typeof window & {
      __sameShaStickyProbe?: { violation: boolean };
    }
  ).__sameShaStickyProbe?.violation ?? false);
}

async function readBridgeProbe(page: Page) {
  return page.evaluate(() => {
    const stored = sessionStorage.getItem("companion-e2e-airi-bridge-probe");
    if (!stored) {
      throw new Error("AIRI bridge probe was not installed.");
    }
    return JSON.parse(stored) as BridgeProbe;
  });
}

function buildAiriFixture(displayFormat: DisplayFormat, characterName: string) {
  const runtimeFormat = displayFormat === "live2d-zip" ? "live2d" : "spine";
  const entrypoint = runtimeFormat === "live2d" ? "avatar.model3.json" : "avatar.json";
  const innerZip = runtimeFormat === "live2d"
    ? makeStoredZip([
      [entrypoint, JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "avatar.moc3", Textures: ["avatar.png"] },
      })],
      ["avatar.moc3", Buffer.from("MOC3-e2e-structure-only")],
      ["avatar.png", onePixelPng()],
    ])
    : makeStoredZip([
      [entrypoint, JSON.stringify({
        skeleton: { spine: "4.2" },
        bones: [{ name: "root" }],
        slots: [],
        skins: [],
      })],
      ["avatar.atlas", "avatar.png\nsize: 1,1\nformat: RGBA8888\n"],
      ["avatar.png", onePixelPng()],
    ]);
  const sha256 = createHash("sha256").update(innerZip).digest("hex");
  const modelPath = "models/body-model.zip";
  const outerZip = makeStoredZip([
    ["manifest.json", JSON.stringify({
      format: "airi-character-card",
      version: 1,
      card: { path: "card.json", spec: "chara_card_v3" },
      resources: {
        displayModel: { format: displayFormat, name: `${runtimeFormat} E2E model`, path: modelPath },
      },
    })],
    ["card.json", JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: characterName,
        description: "仅用于 structure-only 桥接测试，不包含专有模型或运行时，也不声称真实引擎可解析。",
        personality: "先核对证据再继续。",
        scenario: "验证本地虚拟形象桥接。",
      },
    })],
    [modelPath, innerZip],
  ]);
  return { entrypoint, innerZip, outerZip, sha256 };
}

function onePixelPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

async function startRuntimeKindProbe(page: Page) {
  await page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __licensedRuntimeKinds?: string[];
      __licensedRuntimeObserver?: MutationObserver;
    };
    runtimeWindow.__licensedRuntimeKinds = [];
    runtimeWindow.__licensedRuntimeObserver?.disconnect();
    const capture = () => {
      document.querySelectorAll<HTMLElement>("[data-avatar-runtime-kind]").forEach((element) => {
        const kind = element.dataset.avatarRuntimeKind;
        if (kind) {
          runtimeWindow.__licensedRuntimeKinds?.push(kind);
        }
      });
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-avatar-runtime-kind"],
      childList: true,
      subtree: true,
    });
    runtimeWindow.__licensedRuntimeObserver = observer;
  });
}

async function readRuntimeKindProbe(page: Page) {
  return page.evaluate(() => {
    const runtimeWindow = window as typeof window & {
      __licensedRuntimeKinds?: string[];
      __licensedRuntimeObserver?: MutationObserver;
    };
    runtimeWindow.__licensedRuntimeObserver?.disconnect();
    return runtimeWindow.__licensedRuntimeKinds ?? [];
  });
}

async function installHydrationRuntimeProbe(page: Page) {
  await page.addInitScript(() => {
    const runtimeWindow = window as typeof window & {
      __licensedHydrationProbe?: {
        kinds: string[];
        sawLoading: boolean;
        violation: boolean;
      };
    };
    const probe = { kinds: [] as string[], sawLoading: false, violation: false };
    runtimeWindow.__licensedHydrationProbe = probe;
    const capture = () => {
      document.querySelectorAll<HTMLElement>("[data-avatar-runtime-kind]").forEach((element) => {
        const kind = element.dataset.avatarRuntimeKind;
        const mode = element.dataset.runtimeMode;
        if (kind) {
          probe.kinds.push(kind);
        }
        if (mode === "loading") {
          probe.sawLoading = true;
        }
        if (kind === "vrm" || kind === "fallback") {
          probe.violation = true;
        }
      });
    };
    const start = () => {
      capture();
      const observer = new MutationObserver(capture);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-avatar-runtime-kind", "data-ready", "data-runtime-mode"],
        childList: true,
        subtree: true,
      });
    };
    if (document.documentElement) {
      start();
    } else {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    }
  });
}

async function readHydrationRuntimeProbe(page: Page) {
  return page.evaluate(() => structuredClone((
    window as typeof window & {
      __licensedHydrationProbe?: {
        kinds: string[];
        sawLoading: boolean;
        violation: boolean;
      };
    }
  ).__licensedHydrationProbe ?? { kinds: [], sawLoading: false, violation: false }));
}

async function importAiriCharacter(page: Page, archive: Buffer, suffix: string) {
  await page.goto("/characters");
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/characters/import"),
  );
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles({
    name: `airi-runtime-${suffix}.zip`,
    mimeType: "application/zip",
    buffer: archive,
  });
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const imported = await response.json() as {
    asset_manifest: Record<string, unknown>;
    id: string;
  };
  await expect(page).toHaveURL(new RegExp(`/characters/${imported.id}$`), { timeout: 60_000 });
  return imported;
}

async function authorizeFocusedBrowser(page: Page) {
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json() as { initialized: boolean };
  const unlockResponse = await page.request.post(
    `${apiBaseUrl}/api/v1/vault/${status.initialized ? "unlock" : "init"}`,
    { data: { password: vaultPassword } },
  );
  expect(unlockResponse.status()).toBe(200);
  const ownerToken = (await unlockResponse.json() as { owner_token?: string }).owner_token;
  expect(ownerToken).toBeTruthy();
  await page.route("**/api/v1/**", async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), Authorization: `Bearer ${ownerToken}` },
    });
  });
  return ownerToken as string;
}

async function ensureSpace(page: Page, ownerToken: string, suffix: string) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.status()).toBe(200);
  const spaces = await response.json() as Array<{ id: string; title?: string }>;
  if (spaces[0]) {
    return spaces[0];
  }
  const created = await page.request.post(`${apiBaseUrl}/api/v1/spaces`, {
    data: {
      goal: "验证显式角色绑定不改动空间默认值",
      name: `E2E AIRI runtime ${suffix}`,
      topic: "AIRI avatar runtime bridge",
    },
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(created.status()).toBe(201);
  return created.json() as Promise<{ id: string; title?: string }>;
}

async function createIsolatedSpace(page: Page, ownerToken: string, suffix: string) {
  const created = await page.request.post(`${apiBaseUrl}/api/v1/spaces`, {
    data: {
      goal: "验证相同归档摘要仍按角色实例隔离运行时状态",
      name: `E2E same SHA runtime ${suffix}`,
      topic: "licensed avatar asset identity",
    },
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(created.status()).toBe(201);
  return created.json() as Promise<{ id: string; title?: string }>;
}

async function navigateToCharacterLibrary(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /角色工作室/ })
    .click();
  await expect(page).toHaveURL(/\/characters$/);
}

async function readSpaceDefaults(page: Page, ownerToken: string) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.status()).toBe(200);
  const spaces = await response.json() as Array<{
    default_character_pack_id?: string | null;
    id: string;
  }>;
  return spaces
    .map(({ id, default_character_pack_id }) => [id, default_character_pack_id ?? null] as const)
    .sort(([left], [right]) => left.localeCompare(right));
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
