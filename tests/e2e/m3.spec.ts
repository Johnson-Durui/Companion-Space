import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M3");

test("learner preferences and course constraints persist", async ({ page, browser, baseURL }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/courses");
  await page.getByRole("button", { name: t.courses.new }).first().click();
  await page.getByLabel(t.courses.name).fill("学习设置验收");
  await page.getByRole("button", { name: t.courses.create }).click();

  await expect(page.getByRole("heading", { name: t.learner.heading, exact: true })).toBeVisible();
  await page.getByText(t.learner.heading, { exact: true }).click();
  await page.getByLabel(t.learner.nickname).fill("小林");
  await page.getByLabel(t.learner.style).selectOption("rigorous");
  await page.getByRole("button", { name: t.learner.saveProfile }).click();
  await expect(page.getByRole("status").filter({ hasText: t.common.saved })).toBeVisible();

  await page.getByLabel(t.learner.sessionMinutes).fill("35");
  await page.getByLabel("周二").uncheck();
  await page.getByLabel("周四").uncheck();
  await page.getByLabel("周五").uncheck();
  await page.getByLabel("周日").uncheck();
  const defaultSave = page.waitForResponse((response) => response.url().endsWith("/enrollment") && response.request().method() === "PUT");
  await page.getByRole("button", { name: t.learner.saveCourse }).click();
  expect((await defaultSave).ok()).toBe(true);

  await page.getByLabel(t.learner.goalType).selectOption("exam");
  await page.getByLabel(t.learner.examName).fill("期末考试");
  await page.getByLabel(t.learner.examDate).fill("2027-01-15");
  await page.getByLabel(t.learner.targetScore).fill("85");
  await page.getByLabel(t.learner.selfLevel).selectOption("attended_but_lost");
  await page.getByRole("button", { name: t.learner.saveCourse }).click();
  await expect(page.getByRole("status").filter({ hasText: t.common.saved })).toHaveCount(2);

  await page.reload();
  await page.getByText(t.learner.heading, { exact: true }).click();
  await expect(page.getByLabel(t.learner.nickname)).toHaveValue("小林");
  await expect(page.getByLabel(t.learner.style)).toHaveValue("rigorous");
  await expect(page.getByLabel(t.learner.examName)).toHaveValue("期末考试");
  await expect(page.getByLabel(t.learner.examDate)).toHaveValue("2027-01-15");
  await expect(page.getByLabel(t.learner.targetScore)).toHaveValue("85");
  await expect(page.getByLabel("周一")).toBeChecked();
  await expect(page.getByLabel("周二")).not.toBeChecked();
  await expect(page.getByLabel("周六")).toBeChecked();
  await page.screenshot({ path: resolve(screenshots, "learner-setup-desktop.png"), fullPage: true });

  const mobile = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mobile.goto(new URL(page.url()).pathname);
    await expect(mobile.getByRole("heading", { name: t.learner.heading, exact: true })).toBeVisible();
    await mobile.getByText(t.learner.heading, { exact: true }).click();
    await expect(mobile.getByLabel(t.learner.nickname)).toHaveValue("小林");
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "learner-setup-mobile.png"), fullPage: true });
  } finally {
    await mobile.close();
  }
});
