import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M5");

test("classroom timeline survives reload and reaches an honest recap", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/lessons/browser-voice-lesson");
  await expect(page.getByRole("button", { name: t.classroom.startText })).toBeVisible();
  await page.getByRole("button", { name: t.classroom.startText }).click();

  await expect(page.getByText("先确认已知条件。", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: resolve(screenshots, "classroom-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshots, "classroom-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.reload();
  await expect(page.getByText(t.classroom.waitingResume)).toBeVisible();
  await page.getByRole("button", { name: t.classroom.resumeLesson }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("radio", { name: "A 按条件推导" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible();

  await page.getByRole("button", { name: t.classroom.end }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: t.classroom.confirmEnd }).click();
  await expect(page.getByTestId("lesson-recap")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(t.classroom.recap, { exact: true })).toBeVisible();
  await expect(page.getByText("本节课复习了如何从条件出发。", { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "recap-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: t.history.replay }).click();
  await page.getByRole("slider").press("End");
  await expect(page.getByText("先确认已知条件。", { exact: true }).first()).toBeVisible();
  const notes = page.waitForEvent("download");
  await page.getByRole("button", { name: t.history.exportBoard }).click();
  expect((await notes).suggestedFilename()).toMatch(/\.md$/);
});
