import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";
import { pick } from "./helpers";

const screenshots = resolve("docs/rebuild/review/V1");
const samplePortrait = resolve("assets/avatars/portraits/chutang.webp");

test("an imported anime portrait can be previewed with pose controls, edited, and deleted", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/characters");
  const upload = page.waitForResponse(
    (response) => response.url().endsWith("/api/v2/characters/import") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: t.characters.import }).setInputFiles(samplePortrait);
  expect((await upload).status()).toBe(201);
  await expect(page.getByTestId("teacher-stage").getByTestId("tutor-video-box")).toBeVisible();
  await page.getByRole("button", { name: t.characters.poses.praise, exact: true }).click();
  await page.getByLabel(t.characters.name).fill("Anime Video Teacher");
  await pick(page, t.characters.style, "rigorous");
  await page.getByRole("button", { name: t.common.save, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Anime Video Teacher" })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "imported-teacher.png"), fullPage: true });
  await page.getByRole("link", { name: t.characters.voice }).click();
  await expect(page.getByLabel(t.voiceSettings.scope).locator("option:checked")).toHaveText("Anime Video Teacher");
});

test("welcome page renders anime video box roster without retired 3D models", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/welcome");
  await expect(page.getByTestId("teacher-stage").getByTestId("tutor-video-box")).toBeVisible();
  const characters: Array<{ appearance: { kind: string } }> = await (await page.request.get("/api/v2/characters")).json();
  expect(characters.every((entry) => entry.appearance.kind !== "vrm")).toBe(true);
  await page.screenshot({ path: resolve(screenshots, "welcome-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshots, "welcome-mobile.png"), fullPage: true });
});

test("WeChat-style TutorVideoBox follows teaching, pointing, and answer feedback events", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });

  await page.goto("/lessons/browser-avatar-teaching-lesson");
  const stage = page.getByTestId("lesson-stage");
  await expect(stage.getByTestId("tutor-video-box")).toBeVisible();
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByText("先确认已知条件。", { exact: true }).first()).toBeVisible();
  await stage.screenshot({ path: resolve(screenshots, "teaching.png") });
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await stage.screenshot({ path: resolve(screenshots, "pointing.png") });

  await page.goto("/lessons/browser-avatar-correct-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await page.getByRole("radio", { name: "A 按条件推导" }).check({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible();
  await page.getByTestId("lesson-stage").screenshot({ path: resolve(screenshots, "correct.png") });

  await page.goto("/lessons/browser-avatar-incorrect-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await page.getByRole("radio", { name: "B 忽略条件" }).check({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect })).toBeVisible();
  await page.getByTestId("lesson-stage").screenshot({ path: resolve(screenshots, "incorrect.png") });
});
