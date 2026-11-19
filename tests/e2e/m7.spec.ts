import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M7");

test("course home shows today's resumable lesson and batched review summary", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.goto("/courses");
  const course = page.locator(".course-list li").filter({ has: page.locator('a[href="/courses/browser-today-course"]') });
  await expect(course.getByText(t.courses.today, { exact: true })).toBeVisible();
  await expect(course.getByText(t.courses.dueReviews.replace("{count}", "0"))).toBeVisible();
  await expect(course.getByRole("link", { name: t.courses.continueLesson })).toHaveAttribute(
    "href", "/lessons/browser-today-lesson",
  );
  await course.getByRole("link", { name: t.courses.continueLesson }).click();
  await expect(page.getByRole("button", { name: t.classroom.startText })).toBeVisible();
  await page.goBack();
  await page.screenshot({ path: resolve(screenshots, "courses-today.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshots, "courses-today-mobile.png"), fullPage: true });
});
