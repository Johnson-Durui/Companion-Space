import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";
import { pick } from "./helpers";

const screenshots = resolve("docs/rebuild/review/M1");
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5FoAAAAASUVORK5CYII=", "base64");

test("welcome, connection roles, and diagnostics use the same local session", async ({ page, browser, baseURL }) => {
  mkdirSync(screenshots, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tutors");
  await expect(page.getByRole("heading", { name: t.welcome.heading })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const roster = page.getByRole("region", { name: t.welcome.label });
  await expect(roster.getByRole("button")).toHaveCount(6);
  const teacherStageImg = page.getByTestId("teacher-stage").getByRole("img");
  await expect(teacherStageImg).toBeVisible();
  await expect.poll(() => teacherStageImg.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: resolve(screenshots, "welcome-desktop.png") });

  const mobile = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mobile.goto("/tutors");
    await expect(mobile.getByRole("heading", { name: t.welcome.heading })).toBeVisible();
    await expect.poll(() => mobile.getByTestId("teacher-stage").getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "welcome-mobile.png") });
    await mobile.goto("/settings");
    await expect(mobile.getByRole("combobox", { name: t.settings.preset, exact: true })).toBeVisible();
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "settings-mobile.png") });
  } finally {
    await mobile.close();
  }

  const alternative = roster.getByRole("button", { pressed: false }).first();
  const name = (await alternative.innerText()).trim();
  await alternative.click();
  const saving = page.waitForResponse((response) => response.url().endsWith("/settings/default-character") && response.request().method() === "PUT");
  await page.getByRole("button", { name: t.welcome.save }).click();
  expect((await saving).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText(t.welcome.chosen)).toBeVisible();

  await page.getByRole("button", { name: t.voice.preview }).click();
  await expect(page.getByText(t.speech.unavailable)).toBeVisible();

  await page.goto("/settings/diagnostics");
  await expect(page.getByRole("link", { name: t.diagnostics.connect })).toBeVisible();
  await page.getByRole("link", { name: t.diagnostics.connect }).click();
  await expect(page.getByRole("combobox", { name: t.settings.preset, exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "settings-desktop.png") });
  await page.getByRole("button", { name: t.settings.all }).click();
  await pick(page, t.settings.preset, "custom");
  await page.getByLabel(t.settings.name, { exact: true }).fill("本地 E2E 服务");
  await page.getByLabel(t.settings.baseUrl, { exact: true }).fill(`${baseURL}/v1`);
  await page.getByLabel(t.settings.apiKey, { exact: true }).fill("fixture-key");
  const connected = page.waitForResponse((response) => response.url().endsWith("/providers/connections") && response.request().method() === "POST");
  await page.getByRole("button", { name: t.settings.create }).click();
  expect((await connected).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "本地 E2E 服务" })).toBeVisible();
  await page.getByRole("button", { name: t.settings.discover }).click();
  await expect(page.locator("datalist option[value='fixture-vision']")).toHaveCount(1);

  for (const [roleName, model] of [[t.roles.live, "fixture-live"], [t.roles.vision, "fixture-vision"]]) {
    const row = page.getByTestId("role-row").filter({ has: page.getByText(roleName, { exact: true }) });
    await row.locator(":scope > summary").click();
    await row.getByLabel(t.settings.modelId).fill(model);
    const assigning = page.waitForResponse((response) => response.url().endsWith("/settings/model-roles") && response.request().method() === "PUT");
    await row.getByRole("button", { name: t.settings.roleSave }).click();
    expect((await assigning).ok()).toBe(true);
    await expect(row.locator(":scope > summary")).toContainText(model);
  }

  await page.getByRole("button", { name: t.settings.test, exact: true }).click();
  await expect(page.getByTestId("test-results").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("test-results").locator('[data-failed="true"]')).toHaveCount(0);
  await page.getByRole("link", { name: t.diagnostics.heading }).first().click();
  await page.getByRole("textbox", { name: t.diagnostics.input }).fill("请回答一个问题");
  await page.getByRole("button", { name: t.common.send }).click();
  await expect(page.getByTestId("reply").first()).toHaveText("测试连接已响应。");
  const imageInput = page.getByLabel(t.diagnostics.image, { exact: true });
  await expect(imageInput).toBeEnabled();
  await imageInput.setInputFiles({ name: "equation.png", mimeType: "image/png", buffer: tinyPng });
  await page.getByRole("button", { name: t.common.send }).click();
  await expect(page.getByTestId("reply").last()).toHaveText("公式：$x^2+1=0$");
  await page.screenshot({ path: resolve(screenshots, "diagnostics-desktop.png") });
  await page.getByRole("navigation", { name: t.app.name }).getByRole("link", { name: t.app.settings }).click();
  await page.getByRole("button", { name: t.settings.all }).click();
  await pick(page, t.settings.preset, "custom");
  const createForm = page.locator("form").filter({ has: page.getByRole("button", { name: t.settings.create }) });
  await createForm.getByLabel(t.settings.name, { exact: true }).fill("备用连接");
  await createForm.getByLabel(t.settings.baseUrl, { exact: true }).fill(`${baseURL}/v1`);
  await createForm.getByLabel(t.settings.apiKey, { exact: true }).fill("fixture-secondary-key");
  await createForm.getByRole("button", { name: t.settings.create }).click();
  await expect(page.getByRole("heading", { name: "备用连接" })).toBeVisible();

  const checker = page.getByTestId("role-row").filter({ has: page.getByText(t.roles.checker, { exact: true }) });
  await checker.locator(":scope > summary").click();
  const connection = checker.getByRole("combobox", { name: t.settings.useConnection });
  await pick(checker, t.settings.useConnection, { label: "本地 E2E 服务" });
  const remaining = await connection.getByRole("option", { name: "备用连接" }).getAttribute("value");
  const obsolete = page.getByTestId("connection-card").filter({ has: page.getByRole("heading", { name: "本地 E2E 服务" }) });
  await obsolete.getByText(t.settings.edit, { exact: true }).click();
  await obsolete.getByRole("button", { name: t.settings.delete }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: t.settings.confirmDelete }).click();
  await expect(obsolete).toHaveCount(0);
  await expect(connection).toHaveValue(remaining!);

  await checker.getByLabel(t.settings.modelId).fill("fixture-checker");
  const reassigned = page.waitForResponse((response) => response.url().endsWith("/settings/model-roles") && response.request().method() === "PUT");
  await checker.getByRole("button", { name: t.settings.roleSave }).click();
  const result = await reassigned;
  expect(result.request().postDataJSON().checker.connection_id).toBe(remaining);
  expect(result.ok()).toBe(true);
  expect(errors).toEqual([]);
});
