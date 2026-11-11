import { expect, test } from "@playwright/test";
import path from "node:path";

const api = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";

test("immersive companion restores the same conversation after unlock and keeps microphone opt-in", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // This suite mutates data; only the default config may start its isolated API.
  expect(path.resolve(testInfo.config.configFile ?? "")).toBe(path.resolve("playwright.config.ts"));
  expect(process.env.PLAYWRIGHT_REUSE_SERVER).not.toBe("1");
  expect(api).toBe("http://127.0.0.1:8100");
  await page.addInitScript(() => {
    Object.assign(window, { __microphoneRequests: 0 });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        (window as unknown as { __microphoneRequests: number }).__microphoneRequests += 1;
        throw new Error("Text-only journey must not request a microphone");
      },
    });
  });
  await page.goto("/vault");
  const status = await (await page.request.get(`${api}/api/v1/vault/status`)).json();
  const action = status.initialized ? "unlock" : "init";
  await page.getByLabel(status.initialized ? "解锁主密码" : "初始化主密码").fill("m7-playwright-pass");
  const authenticated = page.waitForResponse((r) => r.url().endsWith(`/api/v1/vault/${action}`) && r.request().method() === "POST");
  await page.getByRole("button", { name: status.initialized ? "解锁 Vault" : "初始化 Vault", exact: true }).click();
  const token = (await (await authenticated).json()).owner_token as string;
  expect(token).toBeTruthy();
  const name = `沉浸共学验收 ${Date.now()}`;
  const created = await page.request.post(`${api}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, topic: "二分查找", goal: "用一个例子理解单调性" },
  });
  expect(created.ok()).toBeTruthy();
  const space = await created.json() as { id: string };
  await page.getByRole("link", { name: "学习空间", exact: true }).click();
  await page.locator("article.info-card").filter({ hasText: name }).getByRole("link", { name }).click();
  await page.getByRole("link", { name: "开始伴学会话" }).click();
  await expect(page.getByRole("textbox", { name: "发送文字消息" })).toBeEnabled({ timeout: 60_000 });
  let sessionPosts = 0;
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/v1/sessions")) sessionPosts += 1; });
  const mode = page.getByRole("button", { name: "沉浸陪伴", exact: true });
  await expect(mode).toBeVisible({ timeout: 5_000 });
  await mode.click();
  await expect(page.locator('[data-presentation="immersive"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "退出沉浸", exact: true })).toBeFocused();
  expect(sessionPosts).toBe(0);
  await page.getByRole("textbox", { name: "发送文字消息" }).fill("请用一个简短例子解释二分查找为什么需要单调性。");
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 30_000 });
  expect(sessionPosts).toBe(1);
  const sessions = await (await page.request.get(`${api}/api/v1/spaces/${space.id}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as Array<{ id: string }>;
  expect(sessions).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`session=${sessions[0].id}.*view=immersive|view=immersive.*session=${sessions[0].id}`));
  await expect(page.locator('[data-runtime-mode="ready"]').first()).toBeVisible({ timeout: 60_000 });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(page.getByRole("textbox", { name: "发送文字消息" })).toBeVisible();
    await expect(page.locator('canvas[data-avatar-runtime-instance]')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("正在加载 VRM 资产。", { exact: true })).toHaveCount(0, { timeout: 60_000 });
    if (!await page.locator(".skip-link").evaluate((link) => link.matches(":focus"))) {
      await expect(page.locator(".skip-link")).not.toBeInViewport();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`immersive-viewport-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`immersive-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const firstReply = await page.locator('[data-role="assistant"]').last().textContent();
  const persistedCallUrl = page.url();
  expect(await page.evaluate(() => (window as unknown as { __microphoneRequests: number }).__microphoneRequests)).toBe(0);
  await page.reload();
  await expect(page).toHaveURL(persistedCallUrl);
  await expect(page.locator('[data-presentation="immersive"]')).toBeVisible();
  await page.getByRole("link", { name: "前往解锁" }).click();
  await page.getByLabel("解锁主密码").fill("m7-playwright-pass");
  const unlocked = page.waitForResponse((r) => r.url().endsWith("/api/v1/vault/unlock") && r.request().method() === "POST");
  await page.getByRole("button", { name: "解锁 Vault", exact: true }).click();
  const renewedToken = (await (await unlocked).json()).owner_token as string;
  await page.getByRole("link", { name: "继续上次共学", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText(firstReply ?? "", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-presentation="study"]')).toBeVisible();
  await expect(page.getByRole("textbox", { name: "发送文字消息" })).toBeEnabled();
  expect(sessionPosts).toBe(1);
  await expect(page.locator('[data-role="assistant"]').last()).toBeVisible();
  await expect(page.getByRole("button", { name: "沉浸陪伴", exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __microphoneRequests: number }).__microphoneRequests)).toBe(0);

  await page.getByRole("link", { name: "返回书房" }).click();
  await expect(page).toHaveURL(/\/room$/, { timeout: 30_000 });
  await expect(page.getByLabel("选择学习空间")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("选择学习空间").selectOption(space.id);
  const resume = page.getByRole("link", { name: `继续${name}的共学`, exact: true });
  await expect(resume).toHaveAttribute("href", `/spaces/${space.id}/call?session=${sessions[0].id}&view=immersive`);
  await resume.click();
  await expect(page.locator('[data-presentation="immersive"]')).toBeVisible();
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText(firstReply ?? "", { timeout: 30_000 });
  const composer = page.getByRole("textbox", { name: "发送文字消息" });
  await expect(composer).toBeEnabled();
  await composer.fill("请再给一个练习。");
  await composer.press("Control+Enter");
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(2, { timeout: 30_000 });
  const restoredSessions = await (await page.request.get(`${api}/api/v1/spaces/${space.id}/sessions`, {
    headers: { Authorization: `Bearer ${renewedToken}` },
  })).json() as Array<{ id: string }>;
  expect(restoredSessions.map((session) => session.id)).toEqual([sessions[0].id]);
  expect(sessionPosts).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __microphoneRequests: number }).__microphoneRequests)).toBe(0);
});
