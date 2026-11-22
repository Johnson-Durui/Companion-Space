import { expect, test, type Page } from "@playwright/test";
import t from "../../apps/web/src/locales/zh-CN.json";

const ALL_ROUTES = [
  "/welcome",
  "/sample-lesson",
  "/characters",
  "/courses",
  "/courses/browser-today-course",
  "/courses/browser-today-course/history",
  "/courses/browser-today-course/review",
  "/courses/browser-today-course/review?plan=browser-today-lesson-item",
  "/courses/browser-today-course/progress",
  "/plan-items/browser-today-lesson-item/practice",
  "/lessons/browser-avatar-teaching-lesson",
  "/lessons/browser-avatar-teaching-lesson/history",
  "/settings",
  "/settings/diagnostics",
  "/this-route-does-not-exist-404",
] as const;

const MOBILE_EXTRA_ROUTES = [
  "/courses/browser-empty-course",
  "/courses/browser-stress-course",
  "/lessons/browser-stress-lesson",
] as const;

async function startClipObserver(page: Page) {
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-testid="lesson-stage"] [data-clip]');
    if (!target) throw new Error("Missing [data-clip] surface inside lesson-stage");
    const win = window as unknown as {
      __seenClips?: string[];
      __clipObserver?: MutationObserver;
    };
    win.__clipObserver?.disconnect();
    win.__seenClips = [];
    const observer = new MutationObserver(() => {
      const value = target.getAttribute("data-clip");
      if (value) win.__seenClips?.push(value);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-clip"] });
    win.__clipObserver = observer;
  });
}

async function readSeenClips(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __seenClips?: string[] };
    return [...(win.__seenClips ?? [])];
  });
}

test("I1: every route has exactly one h1, distinct document titles, and resets scroll on navigation", async ({ page }) => {
  const titles = new Map<string, string>();
  for (const route of ALL_ROUTES) {
    await page.goto(route);
    const headings = page.getByRole("heading", { level: 1 });
    await expect(headings.first(), `route ${route} should render an h1`).toBeVisible({ timeout: 15_000 });
    await expect(headings, `route ${route} should have exactly one h1`).toHaveCount(1);
    const title = await page.title();
    expect(title, `route ${route} title should be non-empty`).toBeTruthy();
    titles.set(route, title);
  }
  expect(new Set(titles.values()).size).toBe(ALL_ROUTES.length);

  // Verify 404 route renders the dedicated not-found page with a link back to /courses.
  await page.goto("/this-route-does-not-exist-404");
  await expect(page.getByRole("heading", { level: 1, name: t.app.notFoundTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: t.app.backCourses })).toHaveAttribute("href", "/courses");

  // Verify parent nav stays highlighted on subpages.
  await page.goto("/courses/browser-today-course");
  await expect(page.getByRole("navigation", { name: t.app.name }).getByRole("link", { name: t.app.courses }))
    .toHaveAttribute("aria-current", "page");

  // Verify empty course without a plan does not claim today's plan is complete.
  await page.goto("/courses");
  const emptyCard = page.getByTestId("course-card").filter({ has: page.locator('a[href="/courses/browser-empty-course"]') });
  await expect(emptyCard).toBeVisible();
  await expect(emptyCard).not.toContainText(t.courses.todayClear);
  await expect(emptyCard).toContainText(t.courses.noPlan);

  // Verify SPA route switch resets scroll position to top and moves focus to h1.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole("navigation", { name: t.app.name }).getByRole("link", { name: t.app.courses }).click();
  await expect(page.getByRole("heading", { level: 1, name: t.courses.heading })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
});

test("I2: no horizontal overflow on any route at 390x844 mobile viewport", async ({ browser, baseURL }) => {
  const mobile = await browser.newPage({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    for (const route of [...ALL_ROUTES, ...MOBILE_EXTRA_ROUTES]) {
      await mobile.goto(route);
      await expect(mobile.getByRole("heading", { level: 1 }).first(), `mobile route ${route} h1`).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => mobile.evaluate(() => document.documentElement.scrollWidth), {
          message: `mobile route ${route} should not overflow 390px horizontally`,
        })
        .toBeLessThanOrEqual(390);
    }
  } finally {
    await mobile.close();
  }
});

test("I9 (U0): wrong answer, dont-know, confused, and hint map to non-praise clips", async ({ page }) => {
  // 1. Pre-start state shows waitingStart (not paused) + quick actions (confused, hint).
  await page.goto("/lessons/browser-avatar-inv-actions-lesson");
  const stage = page.getByTestId("lesson-stage");
  await expect(stage).toContainText(t.classroom.waitingStart);
  await expect(stage).not.toContainText(t.classroom.paused);

  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await expect(stage.locator("[data-clip]")).toBeVisible();

  await startClipObserver(page);
  await page.getByRole("button", { name: t.classroom.quick.confused }).click();
  await expect.poll(() => readSeenClips(page)).toContain("react_comfort");
  await page.waitForTimeout(400);
  expect(await readSeenClips(page)).not.toContain("react_praise");

  await expect(page.getByRole("button", { name: t.classroom.quick.hint })).toBeEnabled({ timeout: 15_000 });
  await startClipObserver(page);
  await page.getByRole("button", { name: t.classroom.quick.hint }).click();
  await expect.poll(() => readSeenClips(page)).toContain("think_chin");
  await page.waitForTimeout(400);
  expect(await readSeenClips(page)).not.toContain("react_praise");

  // 2. Wrong answer triggers comfort clip, never praise.
  await page.goto("/lessons/browser-avatar-inv-incorrect-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "B 忽略条件" })).toBeVisible({ timeout: 20_000 });
  await startClipObserver(page);
  await page.getByRole("radio", { name: "B 忽略条件" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readSeenClips(page)).toContain("react_comfort");
  await page.waitForTimeout(400);
  expect(await readSeenClips(page)).not.toContain("react_praise");

  // 3. "Don't know" triggers comfort clip, never praise.
  await page.goto("/lessons/browser-avatar-inv-dontknow-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("button", { name: t.classroom.dontKnow })).toBeVisible({ timeout: 20_000 });
  await startClipObserver(page);
  await page.getByRole("button", { name: t.classroom.dontKnow }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.dont_know })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readSeenClips(page)).toContain("react_comfort");
  await page.waitForTimeout(400);
  expect(await readSeenClips(page)).not.toContain("react_praise");
});

test("I3: destructive flows use in-app ConfirmDialog with safe cancel focus and never native browser dialogs", async ({ page }) => {
  let nativeDialogFired = false;
  page.on("dialog", (dialog) => {
    nativeDialogFired = true;
    void dialog.dismiss();
  });

  // 1. Classroom end confirmation uses AlertDialog and focuses the safe keep-lesson button.
  await page.goto("/lessons/browser-avatar-teaching-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("button", { name: t.classroom.end })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.end }).click();
  const alertDialog = page.getByRole("alertdialog");
  await expect(alertDialog).toBeVisible();
  await expect(alertDialog.getByRole("button", { name: t.classroom.keepLesson })).toBeFocused();
  await alertDialog.getByRole("button", { name: t.classroom.keepLesson }).click();
  await expect(alertDialog).toBeHidden();

  // 2. Course knowledge-point delete confirmation uses AlertDialog.
  await page.goto("/courses/browser-today-course");
  await page.getByRole("button", { name: t.courses.revise }).first().click();
  await page.getByText(t.courses.moreRevisions, { exact: true }).click();
  await page.getByRole("button", { name: t.common.remove }).last().click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: t.common.keep }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();

  expect(nativeDialogFired).toBe(false);
});

test("I5: saving settings emits an accessible status toast that auto-dismisses", async ({ page }) => {
  await page.goto("/settings");
  const dataSection = page.getByRole("region", { name: t.settings.data });
  await expect(dataSection).toBeVisible({ timeout: 15_000 });
  const saveButton = dataSection.getByRole("button", { name: t.common.save });
  await saveButton.click();

  const statusToast = page.getByTestId("toast-item").filter({ hasText: t.common.saved });
  await expect(statusToast).toBeVisible({ timeout: 10_000 });
  await expect(statusToast).toHaveAttribute("role", "status");
  // Wait for auto-dismiss (~5s default).
  await expect(statusToast).toBeHidden({ timeout: 8_000 });
});
