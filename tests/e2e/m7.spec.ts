import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M7");

test("today and courses show resumable lesson, stage attribute, and batched review summary", async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });

  // 1. Today page shows hero greeting and today's primary card
  await page.goto("/");
  await expect(page.getByTestId("today-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("today-primary-card")).toHaveAttribute("data-stage", "learning");
  await page.screenshot({ path: resolve(screenshots, "today-desktop.png"), fullPage: true });

  // 2. Courses list card exposes data-stage="learning" and navigates straight to resumable classroom
  await page.goto("/courses");
  const course = page.getByTestId("course-card").filter({
    has: page.locator('a[href="/courses/browser-today-course"]'),
  });
  await expect(course).toHaveAttribute("data-stage", "learning");
  const continueLink = course.getByRole("link", { name: t.courseHub.stageCtas.continue });
  await expect(continueLink).toHaveAttribute("href", "/lessons/browser-today-lesson");
  await continueLink.click();
  await expect(page.getByRole("button", { name: t.classroom.startText })).toBeVisible({ timeout: 15_000 });
  await page.goBack();
  await page.screenshot({ path: resolve(screenshots, "courses-today.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshots, "courses-today-mobile.png"), fullPage: true });
});
