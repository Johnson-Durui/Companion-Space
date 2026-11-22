import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/V1");
const samplePortrait = resolve("assets/avatars/portraits/chutang.webp");

test("an imported anime portrait can be previewed with pose controls, edited, and deleted", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  // Legacy /characters redirects to /tutors gallery
  await page.goto("/characters");
  await expect(page).toHaveURL(/\/tutors$/);

  // Open 3-step import wizard from the import tile
  await page.getByTestId("import-tutor-tile").click();
  const wizard = page.getByTestId("import-tutor-wizard");
  await expect(wizard).toBeVisible();
  const upload = page.waitForResponse(
    (response) => response.url().endsWith("/api/v2/characters/import") && response.request().method() === "POST",
  );
  await wizard.locator('input[type="file"]').setInputFiles(samplePortrait);
  expect((await upload).status()).toBe(201);

  // Step 2: name & tagline
  await wizard.getByLabel(t.characters.name).fill("Anime Video Teacher");
  await wizard.getByRole("button", { name: t.tutorsGallery.importNext }).click();

  // Step 3: style & voice -> save without switching default or set as mine
  await wizard.getByRole("combobox", { name: t.characters.style }).click();
  await page.getByRole("option", { name: t.learner.styles.rigorous }).click();
  await wizard.getByRole("button", { name: t.tutorsGallery.importFinish }).click();
  await expect(wizard).toBeHidden();

  await expect(page.getByTestId("teacher-stage").getByTestId("tutor-video-box")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Anime Video Teacher" })).toBeVisible();
  await page.getByRole("button", { name: t.tutorsGallery.demoPraise, exact: true }).click();
  await page.screenshot({ path: resolve(screenshots, "imported-teacher.png"), fullPage: true });

  // Open Persona detail tab, edit & delete custom tutor via ConfirmDialog
  await page.getByRole("link", { name: t.tutorsGallery.editPersona }).click();
  await expect(page.getByTestId("tutor-persona-form")).toBeVisible();
  await page.getByRole("button", { name: t.characters.delete }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: t.characters.confirmDelete }).click();
  await expect(page).toHaveURL(/\/tutors$/);

  // Verify built-in tutor edit + reset to default
  await page.goto("/tutors/tutor-chutang?tab=persona");
  await expect(page.getByTestId("tutor-persona-form")).toBeVisible();
  await page.getByLabel(t.tutorsGallery.tagline).fill("测试临时气质");
  await page.getByRole("button", { name: t.common.save, exact: true }).click();
  await expect(page.getByTestId("toast-item").filter({ hasText: t.common.saved })).toBeVisible();
  await page.getByRole("button", { name: t.tutorsGallery.resetDefault }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: t.tutorsGallery.resetAction }).click();
  await expect(page.getByLabel(t.tutorsGallery.tagline)).toHaveValue("清新温暖");
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
