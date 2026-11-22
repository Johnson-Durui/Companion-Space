import { expect, test } from "@playwright/test";
import t from "../../apps/web/src/locales/zh-CN.json";

test("renders validated math, table, and plot blocks while invalid diagrams fail visibly", async ({ page }) => {
  await page.goto("/lessons/browser-board-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();

  await expect(page.locator('[data-kind="math"]')).toBeVisible();
  await expect(page.locator('[data-kind="math"]')).not.toContainText(t.classroom.boardRenderError);
  await expect(page.locator('[data-kind="math"] math')).toHaveCount(1);
  await expect(page.locator('[data-kind="table"] table')).toBeVisible();
  await expect(page.locator('[data-kind="plot"] svg')).toBeVisible({ timeout: 15_000 });
  const diagram = page.locator('[data-kind="diagram"]');
  await expect(diagram).toContainText(t.classroom.boardRenderError, { timeout: 15_000 });
  await expect(diagram.getByText("flowchart TD")).not.toBeVisible();
  await diagram.locator("summary", { hasText: t.classroom.boardViewSource }).click();
  await expect(diagram.getByText("flowchart TD")).toBeVisible();
});

