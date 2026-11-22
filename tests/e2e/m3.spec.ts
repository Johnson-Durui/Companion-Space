import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";
import { pick } from "./helpers";

const screenshots = resolve("docs/rebuild/review/M3");

test("learner preferences and course constraints persist", async ({ page, browser, baseURL }) => {
  mkdirSync(screenshots, { recursive: true });

  // 1. Save learner profile preferences in Settings > Me (legacy /settings#me redirects to /settings/me)
  await page.goto("/settings#me");
  await expect(page).toHaveURL(/\/settings\/me$/);
  const profileForm = page.getByTestId("profile-settings-form");
  await expect(profileForm).toBeVisible({ timeout: 15_000 });
  await profileForm.getByLabel(t.learner.nickname).fill("小林");
  await pick(profileForm, t.learner.style, "rigorous");
  await expect(page.getByTestId("unsaved-bar")).toBeVisible();
  await profileForm.getByRole("button", { name: t.learner.saveProfile }).click();
  await expect(page.getByTestId("toast-item").filter({ hasText: t.common.saved })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("profile-settings-form").getByLabel(t.learner.nickname)).toHaveValue("小林");
  await expect(
    page.getByTestId("profile-settings-form").getByRole("combobox", { name: t.learner.style }),
  ).toContainText(t.learner.styles.rigorous);

  // 2. Create a course and configure constraints via Course Settings dialog (and verify B11 rename!)
  await page.goto("/courses");
  await page.getByRole("button", { name: t.courses.new }).first().click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel(t.courses.name).fill("课程约束验收");
  await createDialog.getByRole("button", { name: t.courses.create }).click();
  await expect(page).toHaveURL(/\/courses\/[^/]+\/setup/, { timeout: 15_000 });
  const courseId = new URL(page.url()).pathname.split("/")[2];

  await page.goto(`/courses/${courseId}?settings=1`);
  const settingsDialog = page.getByRole("dialog");
  await expect(settingsDialog).toBeVisible({ timeout: 15_000 });

  await settingsDialog.getByRole("combobox", { name: t.learner.goalType }).click();
  await page.getByRole("option", { name: t.learner.goals.exam }).click();
  await settingsDialog.getByLabel(t.learner.examName).fill("期末考试");
  await settingsDialog.getByLabel(t.learner.examDate).fill("2027-01-15");
  await settingsDialog.getByLabel(t.learner.targetScore).fill("85");
  await settingsDialog.getByLabel(t.learner.sessionMinutes).fill("35");
  await settingsDialog.getByRole("button", { name: "周二", exact: true }).click();
  await settingsDialog.getByRole("button", { name: "周四", exact: true }).click();

  const savedEnrollment = page.waitForResponse(
    (response) => response.url().endsWith("/enrollment") && response.request().method() === "PUT",
  );
  await settingsDialog.getByRole("button", { name: t.learner.saveCourse }).click();
  expect((await savedEnrollment).ok()).toBe(true);

  await page.goto(`/courses/${courseId}?settings=1`);
  const reloadedDialog = page.getByRole("dialog");
  await expect(reloadedDialog.getByLabel(t.learner.examName)).toHaveValue("期末考试");
  await expect(reloadedDialog.getByLabel(t.learner.examDate)).toHaveValue("2027-01-15");
  await expect(reloadedDialog.getByLabel(t.learner.targetScore)).toHaveValue("85");
  await expect(reloadedDialog.getByRole("button", { name: "周一", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedDialog.getByRole("button", { name: "周二", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: resolve(screenshots, "learner-setup-desktop.png"), fullPage: true });

  const mobile = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mobile.goto(`/courses/${courseId}/setup?step=interview`);
    await expect(mobile.getByTestId("setup-interview-step")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "learner-setup-mobile.png"), fullPage: true });
  } finally {
    await mobile.close();
  }
});
