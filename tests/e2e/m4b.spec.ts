import { expect, test } from "@playwright/test";
import t from "../../apps/web/src/locales/zh-CN.json";

test("renders validated math, table, and plot blocks while invalid diagrams fail visibly", async ({ page }) => {
  await page.goto("/lessons/browser-board-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();

  await expect(page.locator('[data-kind="math"] .katex')).toBeVisible();
  await expect(page.locator('[data-kind="table"] table')).toBeVisible();
  await expect(page.locator('[data-kind="plot"] svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-kind="diagram"]')).toContainText(t.classroom.boardRenderError, { timeout: 15_000 });
  await expect(page.locator('[data-kind="diagram"]')).toContainText("flowchart TD");
});

