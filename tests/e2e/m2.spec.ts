import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M2");
const textbook = Buffer.from("# 条件关系\n\n已知一个条件成立时，可以依据规则判断相应结果。\n\n## 结果计算\n\n先识别条件，再把信息代入规则完成计算。", "utf8");
const exam = Buffer.from("# 2025 阶段测试\n\n1. 根据材料，正确结果是哪一项？\n\nA. 不成立\nB. 成立\n\n答案：B（10 分）", "utf8");

test("materials become a resumable course map with provenance and exams", async ({ page, browser, baseURL }) => {
  mkdirSync(screenshots, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: t.courses.heading })).toBeVisible();
  expect((await page.locator(".skip").boundingBox())?.y).toBeLessThan(0);
  await page.getByRole("button", { name: t.courses.new }).first().click();
  await page.getByLabel(t.courses.name).fill("条件关系入门");
  await page.getByLabel(t.courses.goal).fill("核对资料中的关键规则与常见题型");
  await page.getByRole("button", { name: t.courses.create }).click();
  await expect(page.getByRole("heading", { name: "条件关系入门" })).toBeVisible();

  const fileInput = page.getByLabel(t.courses.choose);
  await fileInput.setInputFiles([
    { name: "课堂笔记.md", mimeType: "text/markdown", buffer: textbook },
    { name: "2025阶段真题含答案.md", mimeType: "text/markdown", buffer: exam },
  ]);
  await expect(page.locator(".pending-file")).toHaveCount(2);
  await expect(page.locator(".pending-file").first().getByRole("combobox", { name: t.courses.role })).toHaveValue("notes");
  await page.getByRole("button", { name: t.courses.upload }).click();
  await expect(page.locator(".material-list article")).toHaveCount(2);

  const teachingMaterial = page.locator(".material-list article").filter({ hasText: "课堂笔记.md" });
  const rolePatch = page.waitForResponse((response) => response.url().includes("/materials/") && response.request().method() === "PATCH");
  await teachingMaterial.getByRole("combobox", { name: t.courses.role }).selectOption("textbook");
  expect((await rolePatch).ok()).toBe(true);
  await expect(teachingMaterial.getByRole("combobox", { name: t.courses.role })).toHaveValue("textbook");

  await page.getByRole("button", { name: t.courses.start }).click();
  await expect(page.locator(".analysis-progress progress")).toBeVisible();
  await expect(page.locator(".analysis-summary")).toContainText(t.courses.jobStatus.completed, { timeout: 30_000 });
  await expect(page.locator(".stage-rail li").nth(0)).toHaveAttribute("data-state", "done");
  await expect(page.locator(".stage-rail li").nth(2)).toHaveAttribute("data-state", "done");

  await expect(page.getByRole("heading", { name: t.courses.mapHeading })).toBeVisible();
  await expect(page.locator(".unit-map button")).toHaveCount(2);
  await expect(page.locator(".source-page")).toContainText("条件关系");
  await expect(page.locator(".source-page")).toContainText("课堂笔记");
  await page.getByRole("button", { name: /查看关联真题/ }).click();
  await expect(page.locator(".exam-browser article")).toContainText("正确结果是哪一项");
  await expect(page.locator(".exam-browser article")).toContainText(t.courses.answerStatus.official_verified);

  await page.getByRole("button", { name: t.courses.revise }).click();
  await page.getByLabel(t.courses.kpName).fill("条件关系（已校对）");
  await page.getByRole("button", { name: t.common.save }).click();
  await expect(page.getByRole("heading", { name: "条件关系（已校对）" })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "course-map-desktop.png"), fullPage: true });

  const coursePath = new URL(page.url()).pathname;
  const mobile = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mobile.goto(coursePath);
    await expect(mobile.getByRole("heading", { name: "条件关系入门" })).toBeVisible();
    await expect(mobile.getByRole("heading", { name: t.courses.mapHeading })).toBeVisible();
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "course-map-mobile.png"), fullPage: true });
  } finally {
    await mobile.close();
  }
  expect(errors).toEqual([]);
});
