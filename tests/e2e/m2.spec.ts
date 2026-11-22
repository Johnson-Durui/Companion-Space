import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import t from "../../apps/web/src/locales/zh-CN.json";

const screenshots = resolve("docs/rebuild/review/M2");
const textbook = Buffer.from(
  "# 条件关系\n\n已知一个条件成立时，可以依据规则判断相应结果。\n\n## 结果计算\n\n先识别条件，再把信息代入规则完成计算。",
  "utf8",
);
const exam = Buffer.from(
  "# 2025 阶段测试\n\n1. 根据材料，正确结果是哪一项？\n\nA. 不成立\nB. 成立\n\n答案：B（10 分）",
  "utf8",
);

test("materials become a resumable course map with provenance and exams", async ({ page, browser, baseURL }) => {
  mkdirSync(screenshots, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: t.courses.heading })).toBeVisible();
  expect((await page.getByRole("link", { name: t.app.skip }).boundingBox())?.y).toBeLessThan(0);

  // Create course via Dialog -> lands on 5-step Course Setup
  await page.getByRole("button", { name: t.courses.new }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(t.courses.name).fill("条件关系入门");
  await dialog.getByLabel(t.courses.goal).fill("核对资料中的关键规则与常见题型");
  await dialog.getByRole("button", { name: t.courses.create }).click();
  await expect(page).toHaveURL(/\/courses\/[^/]+\/setup/, { timeout: 15_000 });
  const courseId = new URL(page.url()).pathname.split("/")[2];

  // Upload files on Step 1 (works even before AI service is connected)
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles([
    { name: "课堂笔记.md", mimeType: "text/markdown", buffer: textbook },
    { name: "2025阶段真题含答案.md", mimeType: "text/markdown", buffer: exam },
  ]);
  await expect(page.getByTestId("pending-file")).toHaveCount(2);

  // If AI not ready yet, upload first then connect via ConnectWizard (auto-starts reading!)
  const uploadOnly = page.getByRole("button", { name: t.setup.uploadOnly });
  if (await uploadOnly.isVisible().catch(() => false)) {
    await uploadOnly.click();
    await expect(page.getByTestId("material-item")).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole("button", { name: t.setup.connectToRead }).click();
    const wizard = page.getByTestId("connect-wizard");
    await expect(wizard).toBeVisible();
    await wizard.getByTestId("preset-card-bigmodel").click();
    await wizard.getByLabel(t.connectWizard.keyLabel).fill("fixture-bigmodel-key");
    await wizard.getByRole("button", { name: t.connectWizard.saveAndTest }).click();
    await expect(wizard.getByRole("button", { name: t.connectWizard.done })).toBeVisible({ timeout: 15_000 });
    await wizard.getByRole("button", { name: t.connectWizard.done }).click();
  } else {
    await page.getByRole("button", { name: t.setup.handToTeacher }).click();
  }

  // Wait for Step 2 reading to complete
  await expect(page.getByTestId("setup-analysis-step")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: t.setup.readingDoneTitle })).toBeVisible({ timeout: 35_000 });

  // Verify materials tab role update (B11)
  await page.goto(`/courses/${courseId}/materials`);
  const teachingMaterial = page.getByTestId("material-item").filter({ hasText: "课堂笔记" });
  await expect(teachingMaterial).toBeVisible();

  // Verify Course Map tab provenance, exam item, and KP revision
  await page.goto(`/courses/${courseId}/map`);
  await expect(page.getByRole("heading", { name: t.courses.mapHeading })).toBeVisible();
  await expect(page.getByRole("navigation", { name: t.courses.mapHeading }).getByRole("button")).toHaveCount(2);
  await expect(page.getByTestId("source-page")).toContainText("条件关系");
  await expect(page.getByTestId("source-page")).toContainText("课堂笔记");
  await page.getByRole("button", { name: /查看关联真题/ }).click();
  await expect(page.getByTestId("exam-item")).toContainText("正确结果是哪一项");
  await expect(page.getByTestId("exam-item")).toContainText(t.courses.answerStatus.official_verified);

  // D5: Without a plan yet, map shows setup guidance rather than prominent open-lesson CTA
  await expect(page.getByRole("link", { name: t.courseHub.mapGoSetup })).toBeVisible();

  await page.getByRole("button", { name: t.courses.revise }).click();
  await page.getByRole("menuitem", { name: t.courses.revise }).click();
  await page.getByLabel(t.courses.kpName).fill("条件关系（已校对）");
  await page.getByRole("button", { name: t.common.save }).click();
  await expect(page.getByRole("heading", { name: "条件关系（已校对）" })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "course-map-desktop.png"), fullPage: true });

  const mobile = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mobile.goto(`/courses/${courseId}/map`);
    await expect(mobile.getByRole("heading", { level: 1, name: "条件关系入门" })).toBeVisible();
    await expect(mobile.getByRole("heading", { name: t.courses.mapHeading })).toBeVisible();
    await expect.poll(() => mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(screenshots, "course-map-mobile.png"), fullPage: true });
  } finally {
    await mobile.close();
  }
  expect(errors).toEqual([]);
});
