import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M6");
const sample = resolve("assets/avatars/models/VRM1_Constraint_Twist_Sample.vrm");

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

test("an imported VRM can be read, previewed, edited, and connected to its voice settings", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/characters");
  const upload = page.waitForResponse((response) => response.url().endsWith("/api/v2/characters/import") && response.request().method() === "POST");
  await page.getByRole("button", { name: t.characters.import, exact: true }).setInputFiles(sample);
  expect((await upload).status()).toBe(201);
  await expect(page.getByText(t.characters.redistributionAllowed)).toBeVisible();
  await expect(page.getByRole("link", { name: t.characters.license, exact: true })).toBeVisible();
  await expect(page.locator(".teacher-stage canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".teacher-stage [aria-busy=false]")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(t.characters.name).fill("VRM lesson teacher");
  await page.getByLabel(t.characters.style).selectOption("rigorous");
  await page.getByRole("button", { name: t.common.save, exact: true }).click();
  await expect(page.getByRole("heading", { name: "VRM lesson teacher" })).toBeVisible();
  await expect(page.locator(".teacher-stage [aria-busy=false] canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    Object.keys(localStorage).some((key) => key.startsWith("companion-space:avatar-snapshot:")),
  )).toBe(true);
  await page.screenshot({ path: resolve(screenshots, "imported-teacher.png"), fullPage: true });
  await page.locator(".teacher-stage").screenshot({ path: resolve(screenshots, "idle.png") });
  await page.locator(".teacher-stage canvas").dispatchEvent("webglcontextlost");
  await expect(page.locator('.teacher-stage img[src^="data:image/png"]')).toBeVisible({ timeout: 5000 });
  await page.locator(".teacher-stage").screenshot({ path: resolve(screenshots, "2d-fallback.png") });
  await page.getByRole("link", { name: t.characters.voice }).click();
  await expect(page.getByLabel(t.voiceSettings.scope).locator("option:checked")).toHaveText("VRM lesson teacher");
});

test("all bundled VRMs display their own preview in desktop and mobile layouts", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/welcome");
  const list = page.locator(".model-roster");
  await expect(list).toBeVisible();
  const characters: Array<{ name: string; appearance: { kind: string }; model_metadata?: unknown }> =
    await (await page.request.get("/api/v2/characters")).json();
  const choices = characters.filter((entry) => entry.appearance.kind === "vrm" && !entry.model_metadata);
  expect(choices).toHaveLength(3);
  for (const [index, teacher] of choices.entries()) {
    await list.getByRole("button").filter({ hasText: teacher.name }).click();
    await expect(page.locator(".teacher-stage [aria-busy=false] canvas")).toBeVisible({ timeout: 15_000 });
    await page.locator(".teacher-stage").screenshot({ path: resolve(screenshots, `bundled-vrm-${index + 1}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshots, "teacher-mobile.png"), fullPage: true });
});

test("a rendered VRM follows teaching, pointing, and answer feedback events", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });

  await page.goto("/lessons/browser-avatar-teaching-lesson");
  await expect(page.locator(".lesson-avatar-canvas[aria-busy=false] canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByText("先确认已知条件。", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(250);
  await page.locator(".lesson-stage").screenshot({ path: resolve(screenshots, "teaching.png") });
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(250);
  await page.locator(".lesson-stage").screenshot({ path: resolve(screenshots, "pointing.png") });

  await page.goto("/lessons/browser-avatar-correct-lesson");
  await expect(page.locator(".lesson-avatar-canvas[aria-busy=false] canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await page.getByRole("radio", { name: "A 按条件推导" }).check({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible();
  await page.waitForTimeout(250);
  await page.locator(".lesson-stage").screenshot({ path: resolve(screenshots, "correct.png") });

  await page.goto("/lessons/browser-avatar-incorrect-lesson");
  await expect(page.locator(".lesson-avatar-canvas[aria-busy=false] canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await page.getByRole("radio", { name: "B 忽略条件" }).check({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect })).toBeVisible();
  await page.waitForTimeout(250);
  await page.locator(".lesson-stage").screenshot({ path: resolve(screenshots, "incorrect.png") });
});
