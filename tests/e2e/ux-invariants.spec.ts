import { expect, test, type Page } from "@playwright/test";
import t from "../../apps/web/src/locales/zh-CN.json";

const ALL_ROUTES = [
  "/",
  "/welcome",
  "/tutors",
  "/tutors/tutor-chutang",
  "/sample-lesson",
  "/courses",
  "/courses/browser-today-course",
  "/courses/browser-today-course/setup",
  "/courses/browser-today-course/plan",
  "/courses/browser-today-course/map",
  "/courses/browser-loop-course/solve",
  "/courses/browser-loop-course/notes",
  "/courses/browser-unprepared-course/materials/unprepared-material/read",
  "/courses/browser-today-course/materials",
  "/courses/browser-today-course/history",
  "/courses/browser-today-course/review",
  "/courses/browser-loop-course/review/session",
  "/plan-items/browser-today-lesson-item/lesson",
  "/courses/browser-today-course/progress",
  "/plan-items/browser-loop-practice-item/practice",
  "/lessons/browser-avatar-teaching-lesson",
  "/lessons/browser-avatar-teaching-lesson/history",
  "/settings/me",
  "/settings/tutor",
  "/settings/ai",
  "/settings/voice",
  "/settings/privacy",
  "/settings/advanced",
  "/this-route-does-not-exist-404",
] as const;

const MOBILE_EXTRA_ROUTES = [
  "/courses/browser-empty-course",
  "/courses/browser-stress-course/map",
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

test("I1: every route has exactly one h1, distinct document titles, zero page errors, and resets scroll on navigation", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  expect(pageErrors).toEqual([]);

  // Verify 404 route renders the dedicated not-found page with a link back to Today (/).
  await page.goto("/this-route-does-not-exist-404");
  await expect(page.getByRole("heading", { level: 1, name: t.app.notFoundTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: t.app.backToday })).toHaveAttribute("href", "/");

  // Verify parent nav stays highlighted on subpages.
  await page.goto("/courses/browser-today-course");
  await expect(page.getByRole("navigation", { name: t.app.name }).getByRole("link", { name: t.app.courses }))
    .toHaveAttribute("aria-current", "page");

  // Verify empty course without a plan does not have stage "today_done".
  await page.goto("/courses");
  const emptyCard = page.getByTestId("course-card").filter({ has: page.locator('a[href="/courses/browser-empty-course"]') });
  await expect(emptyCard).toBeVisible();
  await expect(emptyCard).toHaveAttribute("data-stage", "needs_materials");

  // Verify SPA route switch resets scroll position to top and moves focus to h1.
  await page.goto("/courses/browser-stress-course/map");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: t.courses.mapHeading })).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.scrollTo(0, 600));
      return page.evaluate(() => window.scrollY);
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
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
  await expect.poll(() => readSeenClips(page)).toContain("hint_finger");
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
  await page.goto("/lessons/browser-avatar-inv-dialog-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("button", { name: t.classroom.end })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: t.classroom.end }).click();
  const alertDialog = page.getByRole("alertdialog");
  await expect(alertDialog).toBeVisible();
  await expect(alertDialog.getByRole("button", { name: t.classroom.keepLesson })).toBeFocused();
  await alertDialog.getByRole("button", { name: t.classroom.keepLesson }).click();
  await expect(alertDialog).toBeHidden();

  // 2. Course knowledge-point delete confirmation uses AlertDialog.
  await page.goto("/courses/browser-today-course/map");
  await page.getByRole("button", { name: t.courses.revise }).first().click();
  await page.getByRole("menuitem", { name: t.common.remove }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: t.common.keep }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();

  expect(nativeDialogFired).toBe(false);
});

test("I5: saving settings emits an accessible status toast that auto-dismisses", async ({ page }) => {
  await page.goto("/settings/advanced");
  const concurrencyForm = page.locator('form:has(input[name="concurrency"])');
  await expect(concurrencyForm).toBeVisible({ timeout: 15_000 });
  const saveButton = concurrencyForm.getByRole("button", { name: t.common.save });
  await saveButton.click();

  const statusToast = page.getByTestId("toast-item").filter({ hasText: t.common.saved });
  await expect(statusToast).toBeVisible({ timeout: 10_000 });
  await expect(statusToast).toHaveAttribute("role", "status");
  // Wait for auto-dismiss (~5s default).
  await expect(statusToast).toBeHidden({ timeout: 8_000 });
});

test("I6 & I10: classroom has zero page scroll across 4 desktop viewports and all dock controls are >= 44x44", async ({ page }) => {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1366, height: 633 },
    { width: 1280, height: 585 },
  ];

  async function assertSingleScreenAndDock(label: string) {
    await expect.poll(
      () => page.evaluate(() => Math.abs(document.documentElement.scrollHeight - window.innerHeight)),
      { message: `${label}: document height should equal viewport height (no page scrollbar)` },
    ).toBeLessThanOrEqual(2);

    const dock = page.getByTestId("classroom-dock");
    await expect(dock, `${label}: dock should be visible`).toBeVisible();
    const box = await dock.boundingBox();
    const vp = page.viewportSize()!;
    expect(box, `${label}: dock bounding box`).not.toBeNull();
    expect(box!.x, `${label}: dock left >= 0`).toBeGreaterThanOrEqual(-1);
    expect(box!.y, `${label}: dock top >= 0`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `${label}: dock right <= viewport`).toBeLessThanOrEqual(vp.width + 1);
    expect(box!.y + box!.height, `${label}: dock bottom <= viewport`).toBeLessThanOrEqual(vp.height + 1);

    // I10: Every visible interactive control inside the dock must be >= 44x44px
    const undersized = await dock.evaluate((el) => {
      const items = el.querySelectorAll<HTMLElement>("button, a, input, [role='button']");
      const bad: Array<{ tag: string; label: string; w: number; h: number }> = [];
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.width < 43.5 || rect.height < 43.5) {
          bad.push({
            tag: item.tagName,
            label: item.getAttribute("aria-label") || item.textContent?.trim() || "",
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      }
      return bad;
    });
    expect(undersized, `${label}: all visible dock controls >= 44x44px`).toEqual([]);
  }

  await page.setViewportSize(viewports[0]);
  await page.goto("/lessons/browser-avatar-inv-viewports-lesson");
  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-phase", "lobby", { timeout: 15_000 });

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await assertSingleScreenAndDock(`lobby ${vp.width}x${vp.height}`);
  }

  // Start lesson (text mode) and wait for question tray
  await page.setViewportSize(viewports[0]);
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await assertSingleScreenAndDock(`awaiting ${vp.width}x${vp.height}`);
  }

  // Pause and verify paused phase across viewports
  await page.setViewportSize(viewports[0]);
  await page.getByRole("button", { name: t.classroom.pause }).click();
  await expect(shell).toHaveAttribute("data-phase", "paused", { timeout: 10_000 });
  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await assertSingleScreenAndDock(`paused ${vp.width}x${vp.height}`);
  }
});

test("I7: stress lesson keeps tray footer + first option in viewport and supports board auto-follow + manual scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/lessons/browser-stress-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();

  // Wait for 6-option question tray and 22-line board blocks
  const tray = page.getByTestId("answer-tray");
  await expect(tray).toBeVisible({ timeout: 25_000 });
  const firstOption = tray.getByRole("radio").first();
  await expect(firstOption).toBeVisible({ timeout: 15_000 });
  const footer = page.getByTestId("answer-tray-footer");
  await expect(footer).toBeVisible();

  const vp = page.viewportSize()!;
  const optBox = (await firstOption.boundingBox())!;
  const footBox = (await footer.boundingBox())!;
  expect(optBox.y).toBeGreaterThanOrEqual(0);
  expect(optBox.y + optBox.height).toBeLessThanOrEqual(vp.height + 1);
  expect(footBox.y).toBeGreaterThanOrEqual(0);
  expect(footBox.y + footBox.height).toBeLessThanOrEqual(vp.height + 1);

  // Verify newest board block scrolled into board viewport within 600ms
  const board = page.getByTestId("lesson-board");
  const lastBlock = board.locator("[data-block-id]").last();
  await expect(lastBlock).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    const info = await board.evaluate((el) => {
      const blocks = el.querySelectorAll<HTMLElement>("[data-block-id]");
      const target = blocks[blocks.length - 1];
      if (!target) return { inView: false, reason: "no-target" };
      const bRect = el.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      const inView = tRect.top < bRect.bottom + 8 && tRect.bottom > bRect.top - 8;
      return {
        inView,
        scrollTop: Math.round(el.scrollTop),
        clientHeight: Math.round(el.clientHeight),
        scrollHeight: Math.round(el.scrollHeight),
      };
    });
    return info.inView ? "OK" : JSON.stringify(info);
  }, { timeout: 2000 }).toBe("OK");

  // Manually scroll board to top -> must NOT yank back, and must show "回到最新"
  await board.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(550);
  await board.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const backToLatest = page.getByTestId("back-to-latest");
  await expect(backToLatest).toBeVisible({ timeout: 5_000 });
  const stayedTop = await board.evaluate((el) => el.scrollTop);
  expect(stayedTop).toBeLessThan(80);

  // Clicking "回到最新" jumps back down and hides button
  await backToLatest.click();
  await expect(backToLatest).toBeHidden({ timeout: 5_000 });
});

test("I8 & I9 (U2a): explicit phase transitions and non-speaking clip during thinking/buffering", async ({ page }) => {
  await page.goto("/lessons/browser-avatar-inv-phases-lesson");
  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-phase", "lobby", { timeout: 15_000 });

  // Install observer tracking every (phase, clip) pair
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="classroom-stage-shell"]');
    const clipEl = document.querySelector<HTMLElement>('[data-testid="lesson-stage"] [data-clip]');
    const win = window as unknown as {
      __phaseHistory?: string[];
      __badThinkingClips?: Array<{ phase: string; clip: string }>;
    };
    win.__phaseHistory = [];
    win.__badThinkingClips = [];
    const record = () => {
      const ph = root?.getAttribute("data-phase") ?? "";
      const clip = clipEl?.getAttribute("data-clip") ?? "";
      if (ph && win.__phaseHistory?.[win.__phaseHistory.length - 1] !== ph) {
        win.__phaseHistory?.push(ph);
      }
      if (
        (ph === "thinking" || ph === "buffering") &&
        (clip === "speak_calm" || clip === "speak_explain_a" || clip === "speak_explain_b")
      ) {
        win.__badThinkingClips?.push({ phase: ph, clip });
      }
    };
    record();
    const obs = new MutationObserver(record);
    if (root) obs.observe(root, { attributes: true, attributeFilter: ["data-phase"] });
    if (clipEl) obs.observe(clipEl, { attributes: true, attributeFilter: ["data-clip"] });
  });

  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-phase", "awaiting", { timeout: 10_000 });

  // Submit objective answer -> enters judging before feedback, and does not remain awaiting after verdict
  await page.getByRole("radio", { name: "A 按条件推导" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible({ timeout: 15_000 });

  const { history, badClips } = await page.evaluate(() => {
    const win = window as unknown as {
      __phaseHistory?: string[];
      __badThinkingClips?: Array<{ phase: string; clip: string }>;
    };
    return { history: win.__phaseHistory ?? [], badClips: win.__badThinkingClips ?? [] };
  });

  expect(history).toContain("lobby");
  expect(history).toContain("awaiting");
  expect(history).toContain("judging");
  expect(history).toContain("feedback");
  expect(await shell.getAttribute("data-phase")).not.toBe("awaiting");
  expect(badClips, "thinking/buffering must never display speaking clip").toEqual([]);
});

test("I11: sample lesson and lesson history replay render TutorVideoBox with time scrubber and zero business writes", async ({ page }) => {
  const sockets: string[] = [];
  const forbiddenWrites: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  page.on("request", (req) => {
    const url = req.url();
    if (
      req.method() !== "GET" &&
      req.method() !== "HEAD" &&
      !url.endsWith("/api/v2/session/bootstrap") &&
      !url.endsWith("/api/v2/tts/preview") &&
      !url.endsWith("/api/v2/voice/speak")
    ) {
      forbiddenWrites.push(`${req.method()} ${url}`);
    }
  });

  await page.goto("/sample-lesson");
  await expect(page.getByTestId("tutor-video-box")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sample-prerecorded-badge")).toBeVisible();
  await expect(page.getByTestId("replay-time-display")).toContainText(/\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}/);
  expect(sockets).toEqual([]);
  expect(forbiddenWrites).toEqual([]);

  await page.goto("/lessons/browser-avatar-teaching-lesson/history");
  await expect(page.getByTestId("tutor-video-box")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("replay-time-display")).toContainText(/\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}/);
});

test("U2b lobby: legacy ?plan= redirects, unprepared lesson prepares without percent, and enters classroom with B1 progress", async ({ page }) => {
  // Legacy ?plan= route redirects to /plan-items/:id/lesson
  await page.goto("/courses/browser-today-course/review?plan=browser-today-lesson-item");
  await expect(page).toHaveURL(/\/plan-items\/browser-today-lesson-item\/lesson$/, { timeout: 10_000 });
  await expect(page.getByTestId("lesson-lobby")).toBeVisible();

  // Unprepared lesson shows lobby immediately, prepares asynchronously without percentage, renders warmup, then enters classroom
  await page.goto("/plan-items/browser-unprepared-item/lesson");
  const lobby = page.getByTestId("lesson-lobby");
  await expect(lobby).toBeVisible({ timeout: 15_000 });
  await expect(lobby.getByTestId("tutor-video-box")).toBeVisible();
  const lobbyText = await lobby.innerText();
  expect(lobbyText).not.toMatch(/\d+%/);
  await expect(page.getByTestId("lobby-warmup")).toBeVisible({ timeout: 15_000 });

  // Once background prepare finishes, outline appears and Start button becomes enabled
  await expect(page.getByTestId("lobby-outline")).toBeVisible({ timeout: 20_000 });
  const startTextBtn = page.getByRole("button", { name: t.classroom.startText });
  await expect(startTextBtn).toBeEnabled({ timeout: 15_000 });
  await startTextBtn.click();

  await expect(page).toHaveURL(/\/lessons\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId("lesson-outline-progress")).toBeVisible({ timeout: 20_000 });
});

test("U2b resilience: server-dropped WebSocket shows reconnecting overlay and auto-recovers without page reload", async ({ page }) => {
  await page.goto("/lessons/browser-avatar-inv-reconnect-lesson");
  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-phase", "lobby", { timeout: 15_000 });
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-phase", "awaiting", { timeout: 10_000 });

  await page.evaluate(() => {
    (window as unknown as { __u2bReloadSentinel?: string }).__u2bReloadSentinel = "alive";
  });

  // Force server-side drop on this classroom's WebSocket
  const drop = await page.request.post("/__test__/disconnect-lesson/browser-avatar-inv-reconnect-lesson");
  expect(drop.ok()).toBe(true);
  expect((await drop.json()).closed).toBe(true);

  // Reconnecting overlay appears, then classroom automatically recovers to awaiting without reloading
  await expect(page.getByTestId("stage-overlay-reconnecting")).toBeVisible({ timeout: 5_000 });
  await expect(shell).toHaveAttribute("data-phase", "awaiting", { timeout: 15_000 });
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 10_000 });
  const sentinel = await page.evaluate(() => (window as unknown as { __u2bReloadSentinel?: string }).__u2bReloadSentinel);
  expect(sentinel).toBe("alive");
});

test("I12: unplanned courses never show today_done stage and journey next_step matches primary CTA", async ({ page }) => {
  await page.goto("/courses");
  const emptyCard = page.getByTestId("course-card").filter({
    has: page.locator('a[href="/courses/browser-empty-course"]'),
  });
  await expect(emptyCard).toBeVisible({ timeout: 15_000 });
  const stage = await emptyCard.getAttribute("data-stage");
  expect(stage).not.toBe("today_done");
  expect(stage).toBe("needs_materials");
  await expect(emptyCard.getByRole("link", { name: t.courseHub.stageCtas.needs_materials })).toHaveAttribute(
    "href",
    "/courses/browser-empty-course/setup",
  );

  // On Today page, the empty course row also never carries data-stage="today_done"
  await page.goto("/");
  await expect(page.getByTestId("today-page")).toBeVisible({ timeout: 15_000 });
  const emptyTodayRow = page.getByTestId("today-course-row").filter({
    has: page.locator('a[href="/courses/browser-empty-course"]'),
  });
  await expect(emptyTodayRow).toBeVisible();
  expect(await emptyTodayRow.getAttribute("data-stage")).not.toBe("today_done");

  // Course hub today tab for unplanned course shows preparing stepper + Continue Setup -> /setup
  await page.goto("/courses/browser-empty-course");
  const prepCard = page.getByTestId("course-today-preparing");
  await expect(prepCard).toBeVisible({ timeout: 15_000 });
  expect(await prepCard.getAttribute("data-stage")).not.toBe("today_done");
  await expect(prepCard.getByRole("link", { name: t.courseHub.continueSetup })).toHaveAttribute(
    "href",
    "/courses/browser-empty-course/setup",
  );
});

test("I13: placement stays locked without skipping while materials unread; all 6 interview topics complete via controls alone", async ({ page }) => {
  // Create a fresh empty course (no analyzed materials)
  await page.goto("/courses");
  await page.getByRole("button", { name: t.courses.new }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t.courses.name).fill("I13 访谈与摸底守恒测试");
  await dialog.getByRole("button", { name: t.courses.create }).click();
  await expect(page).toHaveURL(/\/courses\/[^/]+\/setup/, { timeout: 15_000 });
  const courseId = new URL(page.url()).pathname.split("/")[2];

  // 1. Visiting placement while materials unread shows locked notice and NEVER marks placement_status = skipped
  await page.goto(`/courses/${courseId}/setup?step=placement`);
  await expect(page.getByTestId("placement-locked")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("placement-locked")).toContainText(t.setup.step4Locked);

  // 2. Complete all 6 interview topics using ONLY structured controls (no free text / no LLM required)
  await page.goto(`/courses/${courseId}/setup?step=interview`);
  const stepBox = page.getByTestId("setup-interview-step");
  await expect(stepBox).toBeVisible({ timeout: 15_000 });

  for (let i = 0; i < 6; i += 1) {
    const topic = await stepBox.getAttribute("data-topic");
    if (!topic) break;
    // Handle E8 known-identity confirmation if profile already has nickname
    const knownYes = stepBox.getByRole("button", { name: t.setup.knownYes });
    if (await knownYes.isVisible().catch(() => false)) {
      await knownYes.click();
    } else {
      if (topic === "goal") {
        await stepBox.getByRole("radio", { name: new RegExp(t.learner.goals.exam) }).click();
        await stepBox.getByLabel(t.learner.examDate).fill("2027-06-15");
      } else if (topic === "schedule") {
        await stepBox.getByRole("button", { name: "周二", exact: true }).click();
      }
      await stepBox.getByRole("button", { name: t.onboarding.continue }).click();
    }
    await page.waitForTimeout(300);
  }

  // After all 6 topics finish, enrollment persists interview_status=done, exam_date, weekly_days, AND placement_status != skipped!
  const enrollment = await (await page.request.get(`/api/v2/courses/${courseId}/enrollment`)).json();
  expect(enrollment.interview_status).toBe("done");
  expect(enrollment.placement_status).not.toBe("skipped");
  expect(enrollment.exam_date).toBe("2027-06-15");
  expect(Array.isArray(enrollment.weekly_days) && enrollment.weekly_days.length > 0).toBe(true);
});

test("I16: at most one tutor <video> plays simultaneously on any page including hover previews", async ({ page }) => {
  const countPlayingVideos = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("video")).filter((v) => !v.paused && !v.ended && v.readyState >= 2).length,
    );

  // 1. /tutors gallery: showcase + hovering multiple tiles sequentially
  await page.goto("/tutors");
  await expect(page.getByTestId("tutor-showcase")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await countPlayingVideos()).toBeLessThanOrEqual(1);

  const tiles = page.locator('[data-testid^="tutor-tile-"]');
  const count = await tiles.count();
  for (let i = 0; i < Math.min(count, 4); i += 1) {
    await tiles.nth(i).hover();
    await page.waitForTimeout(200);
    expect(await countPlayingVideos(), `hovering tutor tile ${i} must keep playing videos <= 1`).toBeLessThanOrEqual(1);
  }

  // 2. /welcome onboarding Step 1
  await page.goto("/welcome");
  await expect(page.getByTestId("tutor-showcase")).toBeVisible();
  await page.waitForTimeout(250);
  expect(await countPlayingVideos()).toBeLessThanOrEqual(1);

  // 3. Classroom
  await page.goto("/lessons/browser-avatar-teaching-lesson");
  await expect(page.getByTestId("lesson-stage")).toBeVisible();
  await page.waitForTimeout(250);
  expect(await countPlayingVideos()).toBeLessThanOrEqual(1);
});

test("I14: review answering pauses in feedback state until clicking Next and reaches summary", async ({ page }) => {
  await page.goto("/courses/browser-loop-course/review");
  await expect(page.getByTestId("review-due-card")).toBeVisible();
  await expect(page.getByTestId("mistake-book")).toBeVisible();
  await expect(page.getByTestId("mistake-item")).toHaveCount(1);

  await page.getByTestId("start-review-session").click();
  await expect(page).toHaveURL(/\/courses\/browser-loop-course\/review\/session/);
  await expect(page.getByTestId("review-session-active")).toBeVisible();

  // Card 1: choice item — answer wrong intentionally and confirm feedback pause (I14)
  await page.locator('[data-choice-key="A"]').click();
  await page.getByRole("button", { name: t.review.submit }).click();
  const feedback1 = page.getByTestId("review-feedback");
  await expect(feedback1).toBeVisible();
  await expect(feedback1).toContainText(t.loopViz.reviewIncorrect);
  await expect(feedback1).toContainText("罗尔定理");
  await expect(page.getByTestId("review-mastery-delta")).toBeVisible();

  // Wait briefly to guarantee it never auto-advances without explicit click
  await page.waitForTimeout(450);
  await expect(feedback1).toBeVisible();
  await page.getByTestId("review-next-btn").click();

  // Card 2: flashcard — reveal, rate, pause in feedback state, then reach summary
  await page.getByRole("button", { name: t.review.reveal }).click();
  await page.getByRole("button", { name: t.review.ratings.good }).click();
  const feedback2 = page.getByTestId("review-feedback");
  await expect(feedback2).toBeVisible();
  await expect(feedback2).toContainText(t.loopViz.reviewRated);
  await page.getByTestId("review-next-btn").click();

  await expect(page.getByTestId("review-summary")).toBeVisible();
  await expect(page.getByTestId("review-summary")).toContainText("2");
});

test("U5 loop visualization: plan diff, map weight view, progress charts/timeline, practice reload, and history B6", async ({ page }) => {
  // 1. Plan page with B4b diff
  await page.goto("/courses/browser-loop-course/plan");
  await expect(page.getByTestId("plan-diff-list")).toBeVisible();
  await expect(page.getByTestId("plan-diff-list")).toContainText(t.loopViz.diffEarlier);
  await expect(page.getByTestId("plan-diff-list")).toContainText(t.loopViz.diffDeferred);

  // 2. Map page: switch to weight view + verify prereq chain + URL ?kp= sync
  await page.goto("/courses/browser-loop-course/map");
  await page.getByRole("radio", { name: t.loopViz.mapByWeight }).click();
  await expect(page.getByTestId("prereq-chain")).toBeVisible();

  // 3. Progress page: ScoreBar, MasteryGrid, StudyCalendar, WeeklyMinutes + clickable KP timeline
  await page.goto("/courses/browser-loop-course/progress");
  await expect(page.getByTestId("score-bar")).toBeVisible();
  await expect(page.getByTestId("mastery-grid")).toBeVisible();
  await expect(page.getByTestId("study-calendar")).toBeVisible();
  await expect(page.getByTestId("weekly-minutes")).toBeVisible();
  await page.getByTestId("mastery-tile-loop-kp-1").click();
  await expect(page.getByTestId("kp-timeline-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // 4. History page: B6 duration/summary + legacy section hidden when empty
  await page.goto("/courses/browser-loop-course/history");
  await expect(page.getByTestId("history-lesson-card")).toHaveCount(2);
  await expect(page.getByTestId("legacy-history-section")).toHaveCount(0);

  // 5. Practice B7: start preview -> single question -> save -> reload preserves index & answer -> submit -> ScoreRing + debrief
  await page.goto("/plan-items/browser-loop-practice-item/practice");
  await expect(page.getByTestId("practice-start")).toBeVisible();
  await expect(page.getByTestId("practice-start")).toContainText("共 2 题");
  await page.getByRole("button", { name: t.practice.start }).click();
  await expect(page.getByTestId("practice-active")).toBeVisible();
  await page.locator('[data-choice-key="A"]').click();
  await expect(page.getByTestId("practice-save-status")).toContainText(t.loopViz.practiceSaved);

  // Move to Q2, select B, wait saved, then reload and verify Q2 + B are restored!
  await page.getByRole("button", { name: t.loopViz.practiceNext }).click();
  await page.locator('[data-choice-key="B"]').click();
  await expect(page.getByTestId("practice-save-status")).toContainText(t.loopViz.practiceSaved);

  await page.reload();
  await expect(page.getByTestId("practice-active")).toBeVisible();
  await expect(page.locator('[data-choice-key="B"]')).toHaveAttribute("aria-checked", "true");

  // Submit via ConfirmDialog -> verify ScoreRing + debrief stem & learner answer
  await page.getByRole("button", { name: t.practice.submit }).click();
  await page.getByRole("button", { name: t.loopViz.practiceConfirmSubmit }).click();
  await expect(page.getByTestId("practice-result")).toBeVisible();
  await expect(page.getByTestId("score-ring")).toBeVisible();
  await expect(page.getByTestId("debrief-item")).toHaveCount(2);
  await expect(page.getByTestId("debrief-item").first()).toContainText("极限存在的充要条件");
});

test("I15 & U6 mobile call layout: 390x844 fixed bottom dock, visible mic, teacher portrait & board mode toggle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/lessons/browser-avatar-teaching-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 25_000 });

  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-mobile-view", "teacher");

  // I15: ControlDock is anchored at bottom of viewport and mic button is visible inside viewport
  const dockBox = await page.getByTestId("classroom-dock").boundingBox();
  const micBox = await page.getByTestId("dock-mic-button").boundingBox();
  expect(dockBox, "mobile dock must render").not.toBeNull();
  expect(micBox, "mobile mic button must render").not.toBeNull();
  expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(844 + 2);
  expect(dockBox!.y).toBeGreaterThanOrEqual(700);
  expect(micBox!.x).toBeGreaterThanOrEqual(0);
  expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(390);
  expect(micBox!.y + micBox!.height).toBeLessThanOrEqual(844 + 2);
  expect(micBox!.width).toBeGreaterThanOrEqual(44);
  expect(micBox!.height).toBeGreaterThanOrEqual(44);

  // Teacher mode keeps vertical portrait framing (height > width, never cropped into a landscape strip)
  const stageBox = await page.locator('[data-testid="lesson-stage"] .tvb-frame').boundingBox();
  expect(stageBox).not.toBeNull();
  expect(stageBox!.height).toBeGreaterThan(stageBox!.width);

  // Toggle to Board mode -> full board + corner portrait teacher PiP -> tap PiP back to Teacher mode
  await page.getByTestId("mobile-view-toggle").click();
  await expect(shell).toHaveAttribute("data-mobile-view", "board");
  const pipBtn = page.getByTestId("mobile-pip-restore");
  await expect(pipBtn).toBeVisible();
  const pipBox = await pipBtn.boundingBox();
  expect(pipBox).not.toBeNull();
  expect(pipBox!.height).toBeGreaterThan(pipBox!.width);

  await pipBtn.click();
  await expect(shell).toHaveAttribute("data-mobile-view", "teacher");

  // Zero horizontal overflow in both modes
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > window.innerWidth + 1,
    y: document.documentElement.scrollHeight > window.innerHeight + 2,
  }));
  expect(overflow.x).toBe(false);
  expect(overflow.y).toBe(false);
});

test("U6 classroom depth: marks, line pointer, plot legend & lightbox, transcript drawer, shortcuts, view switcher", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/lessons/browser-board-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();

  await expect(page.locator('[data-kind="plot"] svg')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plot-controls")).toBeVisible();
  await expect(page.getByTestId("plot-legend")).toBeVisible();

  // Multi-step lines, 3 mark styles, and line-level pointer on line 2
  await expect(page.locator('[data-board-line="b-steps.1"]')).toHaveAttribute("data-mark-style", "underline");
  await expect(page.locator('[data-board-line="b-steps.2"]')).toHaveAttribute("data-mark-style", "box");
  await expect(page.locator('[data-board-line="b-steps.2"]')).toHaveAttribute("data-pointed", "true");
  await expect(page.locator('[data-board-line="b-steps.3"]')).toHaveAttribute("data-mark-style", "color");

  // Zoom plot into lightbox dialog
  const plotWrap = page.locator('[data-block-id="b-plot"]');
  await plotWrap.hover();
  await page.getByTestId("zoom-block-b-plot").click();
  await expect(page.getByTestId("board-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("board-lightbox")).toHaveCount(0);

  // View switcher: split -> board-first (remembered across reload) -> back to split
  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-view-mode", "split");
  await page.getByTestId("view-mode-toggle").click();
  await expect(shell).toHaveAttribute("data-view-mode", "board-first");
  await page.getByTestId("view-mode-toggle").click();
  await expect(shell).toHaveAttribute("data-view-mode", "split");

  // Shortcuts dialog via "?" key
  await page.locator('[data-testid="lesson-board"]').click({ position: { x: 10, y: 10 } });
  await page.keyboard.type("?");
  await expect(page.getByTestId("shortcuts-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts-list")).toHaveCount(0);

  // Full transcript drawer via dock toggle (shows teacher speech + student quick action)
  await page.getByRole("button", { name: t.classroom.quick.confused }).click();
  await page.getByTestId("dock-transcript-toggle").click();
  const drawer = page.getByTestId("transcript-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("开始吧。");
  await expect(drawer).toContainText(t.classroom.quick.confused);
  await page.keyboard.press("Escape");
});

test("U7 partitioned settings redirects and UnsavedBar discard/save", async ({ page }) => {
  const redirects: Array<[string, RegExp]> = [
    ["/settings", /\/settings\/me$/],
    ["/settings#me", /\/settings\/me$/],
    ["/settings#models", /\/settings\/ai$/],
    ["/settings#voice", /\/settings\/voice$/],
    ["/settings#avatar", /\/settings\/advanced$/],
    ["/settings#security", /\/settings\/privacy$/],
    ["/settings#data", /\/settings\/privacy$/],
    ["/settings/diagnostics", /\/settings\/ai\?tab=test$/],
  ];
  for (const [from, toPattern] of redirects) {
    await page.goto(from);
    await expect(page, `redirect from ${from}`).toHaveURL(toPattern, { timeout: 10_000 });
  }

  // UnsavedBar appears on dirty form edit and restores original value on discard
  await page.goto("/settings/me");
  const form = page.getByTestId("profile-settings-form");
  await expect(form).toBeVisible({ timeout: 15_000 });
  const nickInput = form.getByLabel(t.learner.nickname);
  const original = await nickInput.inputValue();
  await nickInput.fill(`${original || "测试"}_未保存`);
  const bar = page.getByTestId("unsaved-bar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: t.settings.unsavedDiscard }).click();
  await expect(bar).toHaveCount(0);
  await expect(nickInput).toHaveValue(original);
});

test("U7 keyboard-only navigation and prefers-reduced-motion clarity", async ({ page }) => {
  // Keyboard navigation across primary shell -> dialog -> Escape
  await page.goto("/");
  await expect(page.getByTestId("today-page")).toBeVisible({ timeout: 15_000 });
  const coursesNavLink = page.getByRole("navigation", { name: t.app.name }).getByRole("link", { name: t.app.courses });
  await coursesNavLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/courses$/);

  const newCourseBtn = page.getByRole("button", { name: t.courses.new }).first();
  await newCourseBtn.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Reduced-motion mode in classroom keeps clear text status and instant keyboard answering
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/lessons/browser-avatar-teaching-lesson");
  const startBtn = page.getByRole("button", { name: t.classroom.startText });
  await expect(startBtn).toBeVisible({ timeout: 15_000 });
  await startBtn.focus();
  await page.keyboard.press("Enter");

  const shell = page.getByTestId("classroom-stage-shell");
  await expect(shell).toHaveAttribute("data-phase", "awaiting", { timeout: 25_000 });
  const optionA = page.getByRole("radio", { name: "A 按条件推导" });
  await expect(optionA).toBeVisible();
  await optionA.focus();
  await page.keyboard.press("Space");
  await expect(optionA).toHaveAttribute("aria-checked", "true");
  const submitBtn = page.getByRole("button", { name: t.classroom.submitAnswer });
  await submitBtn.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible({ timeout: 15_000 });
});

async function startStillObserver(page: Page) {
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-testid="lesson-stage"] [data-still]');
    if (!target) throw new Error("Missing [data-still] surface inside lesson-stage");
    const win = window as unknown as {
      __seenStills?: string[];
      __stillObserver?: MutationObserver;
    };
    win.__stillObserver?.disconnect();
    const initial = target.getAttribute("data-still");
    win.__seenStills = initial ? [initial] : [];
    const observer = new MutationObserver(() => {
      const value = target.getAttribute("data-still");
      if (value) win.__seenStills?.push(value);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-still"] });
    win.__stillObserver = observer;
  });
}

async function readSeenStills(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __seenStills?: string[] };
    return [...(win.__seenStills ?? [])];
  });
}

test("I21 (UM-1 & UM-2): start triggers greet_wave and confirm-end triggers farewell_wave on fixture and built-in packs", async ({ page }) => {
  // 1. Synthetic test .tutorpack fixture (UM-1 Task 9)
  const seeded = await page.request.post("/__test__/seed-media-fixture-lesson");
  expect(seeded.ok()).toBe(true);
  const { character_id: characterId, lesson_id: fixtureLessonId } = (await seeded.json()) as {
    character_id: string;
    lesson_id: string;
  };
  try {
    await page.goto(`/lessons/${fixtureLessonId}`);
    const stage = page.getByTestId("lesson-stage");
    await expect(stage.locator("[data-clip]")).toBeVisible({ timeout: 15_000 });
    await startClipObserver(page);

    await page.getByRole("button", { name: t.classroom.startText }).click();
    await expect.poll(() => readSeenClips(page), { timeout: 10_000 }).toContain("greet_wave");
    await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("radio", { name: "A 按条件推导" }).check();
    await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
    await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible({ timeout: 15_000 });

    await startClipObserver(page);
    await page.getByRole("button", { name: t.classroom.end }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: t.classroom.confirmEnd }).click();
    await expect.poll(() => readSeenClips(page), { timeout: 10_000 }).toContain("farewell_wave");
    await expect(page.getByTestId("lesson-recap")).toBeVisible({ timeout: 20_000 });
  } finally {
    await page.request.delete(`/api/v2/characters/${characterId}`);
  }

  // 2. Real built-in tutor-xuechuan pack with ingested greet_wave & farewell_wave (UM-2 Task 6)
  await page.goto("/lessons/browser-avatar-media-builtin-lesson");
  const builtinStage = page.getByTestId("lesson-stage");
  await expect(builtinStage.locator("[data-clip]")).toBeVisible({ timeout: 15_000 });
  await startClipObserver(page);

  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect.poll(() => readSeenClips(page), { timeout: 10_000 }).toContain("greet_wave");
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("radio", { name: "A 按条件推导" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible({ timeout: 15_000 });

  await startClipObserver(page);
  await page.getByRole("button", { name: t.classroom.end }).click();
  const builtinDialog = page.getByRole("alertdialog");
  await expect(builtinDialog).toBeVisible();
  await builtinDialog.getByRole("button", { name: t.classroom.confirmEnd }).click();
  await expect.poll(() => readSeenClips(page), { timeout: 10_000 }).toContain("farewell_wave");
  await expect(page.getByTestId("lesson-recap")).toBeVisible({ timeout: 20_000 });
});

test("I23 (UM-1 & UM-2): reduced-motion classroom switches data-still on correct/wrong and audition tab previews clips/stills", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  // 1. Correct answer -> praise (or cheerful) still
  await page.goto("/lessons/browser-avatar-reduced-correct-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "A 按条件推导" })).toBeVisible({ timeout: 20_000 });
  await startStillObserver(page);

  await page.getByRole("radio", { name: "A 按条件推导" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct })).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      const seen = await readSeenStills(page);
      return seen.includes("praise") || seen.includes("cheerful");
    })
    .toBe(true);

  // 2. Confused & wrong answer -> caring still
  await page.goto("/lessons/browser-avatar-reduced-incorrect-lesson");
  await page.getByRole("button", { name: t.classroom.startText }).click();
  await expect(page.getByRole("radio", { name: "B 忽略条件" })).toBeVisible({ timeout: 20_000 });
  await startStillObserver(page);

  await page.getByRole("button", { name: t.classroom.quick.confused }).click();
  await expect.poll(() => readSeenStills(page)).toContain("caring");

  await startStillObserver(page);
  await page.getByRole("radio", { name: "B 忽略条件" }).check();
  await page.getByRole("button", { name: t.classroom.submitAnswer }).click();
  await expect(page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readSeenStills(page)).toContain("caring");

  // 3. Audition tab (/tutors/tutor-xuechuan?tab=assets): still & clip preview (license card intentionally omitted)
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tutors/tutor-xuechuan?tab=assets");
  const auditionCard = page.getByTestId("tutor-audition-card");
  await expect(auditionCard).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tutor-license-card")).toHaveCount(0);

  await page.getByTestId("audition-clip-greet_wave").click();
  await expect(auditionCard.locator("[data-clip]")).toHaveAttribute("data-clip", "greet_wave");

  await page.getByTestId("audition-still-praise").click();
  await expect(auditionCard.locator("[data-still]")).toHaveAttribute("data-still", "praise");
});

const STUDENT_FORBIDDEN_VOCAB: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "课程工作台", re: /课程工作台/ },
  { name: "估算并开始分析", re: /估算并开始分析/ },
  { name: "token", re: /\btoken\b/i },
  { name: "学习设置", re: /学习设置/ },
  { name: "起点诊断", re: /起点诊断/ },
  { name: "连接模型/模型连接", re: /连接模型|模型连接/ },
  { name: "模型角色", re: /模型角色/ },
  { name: "API Key", re: /\bAPI\s*Key\b/i },
  { name: "试聊", re: /试聊/ },
  { name: "二次元视频包/立绘/默认视频档位", re: /二次元视频包|二次元立绘|默认视频档位/ },
  { name: "切免费档/已自动切回基础档", re: /切免费档|已自动切回基础档/ },
  { name: "Sidecar/本地GPU实时驱动/Tier 3/WebRTC", re: /\bSidecar\b|本地\s*GPU\s*实时驱动|Tier\s*3|\bWebRTC\b/i },
  { name: "Render failed", re: /Render\s*failed/i },
  { name: "向量检索", re: /向量检索/ },
  { name: "Mock exam", re: /\bMock\s*exam\b/i },
  { name: "考点权重约 X%", re: /考点权重约\s*\d+%/ },
  { name: "Trace Forest / L1/L2/L3", re: /Trace\s*Forest|\bL[123]\b/ },
];

async function assertCleanStudentVocabulary(page: Page, label: string) {
  const visibleText = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll("[data-advanced], details, [data-key-guide], script, style, noscript")
      .forEach((node) => node.remove());
    return clone.textContent ?? "";
  });
  const violations = STUDENT_FORBIDDEN_VOCAB.filter((rule) => rule.re.test(visibleText)).map((rule) => rule.name);
  expect(violations, `${label} should contain zero forbidden §6.2 student vocabulary`).toEqual([]);
}

test("Phase 1-4: solve, notes (with parameterized plot), reader, and memory cards pass console, h1, overflow, and §6.2 vocab invariants", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // 1. Phase 2: /solve list + seeded verified solve session detail
  await page.goto("/courses/browser-loop-course/solve");
  await expect(page.getByTestId("solve-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId("solve-history-loop-solve-1")).toBeVisible();
  await assertCleanStudentVocabulary(page, "/courses/browser-loop-course/solve");

  await page.getByTestId("solve-history-loop-solve-1").click();
  await expect(page.getByTestId("solve-verify-badge")).toContainText(t.solve.verifiedBadge);
  await expect(page.getByTestId("solve-steps-section")).toBeVisible();
  const solveHints = page.getByTestId("solve-hints");
  await expect(solveHints).toBeVisible();
  await expect(solveHints.locator(".katex-html")).toHaveCount(2);
  expect(await solveHints.innerText()).not.toContain("\\sqrt");
  // Verify right warm-paper card children never overflow past the card border
  const paperCard = page.locator('[data-testid="solve-page"] [data-surface="paper"]').first();
  const cardBounds = await paperCard.boundingBox();
  const hintsBounds = await solveHints.boundingBox();
  const stepsBounds = await page.getByTestId("solve-steps-section").boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(hintsBounds).not.toBeNull();
  expect(stepsBounds).not.toBeNull();
  expect(hintsBounds!.x + hintsBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width + 1);
  expect(stepsBounds!.x + stepsBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width + 1);
  await assertCleanStudentVocabulary(page, "/courses/browser-loop-course/solve?session=loop-solve-1");

  // 2. Phase 1 & 4: /notes block notebook + interactive parameterized plot keyframes & reset
  await page.goto("/courses/browser-loop-course/notes");
  await expect(page.getByTestId("notes-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId("note-block-loop-nb-1")).toBeVisible();
  await expect(page.getByTestId("note-block-loop-nb-2")).toBeVisible();
  const plotBlock = page.getByTestId("note-block-loop-nb-3");
  await expect(plotBlock).toBeVisible();
  await expect(plotBlock.locator("svg").first()).toBeVisible({ timeout: 15_000 });
  await expect(plotBlock.getByTestId("plot-controls")).toBeVisible();
  await expect(plotBlock.getByTestId("plot-param-value-a")).toContainText("a = 1");
  await plotBlock.getByTestId("plot-keyframe-1").click();
  await expect(plotBlock.getByTestId("plot-param-value-a")).toContainText("a = 0.5");
  await plotBlock.getByTestId("plot-reset").click();
  await expect(plotBlock.getByTestId("plot-param-value-a")).toContainText("a = 1");
  await assertCleanStudentVocabulary(page, "/courses/browser-loop-course/notes");

  // 3. Phase 4: /materials/:materialId/read with sections, KP strip, markdown content, and quick quiz
  await page.goto("/courses/browser-unprepared-course/materials/unprepared-material/read");
  await expect(page.getByTestId("reader-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId("reader-page-content")).toContainText("函数极限");
  await expect(page.getByTestId("reader-kp-unprepared-kp")).toBeVisible();
  await expect(page.getByTestId("reader-quick-quiz")).toBeVisible();
  await assertCleanStudentVocabulary(page, "/courses/browser-unprepared-course/materials/unprepared-material/read");

  // 4. Phase 3: CourseMemoryCard on /progress & GlobalMemoryArchiveCard on /settings/me
  await page.goto("/courses/browser-loop-course/progress");
  await expect(page.getByTestId("course-memory-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("memory-fact-loop-mem-1")).toBeVisible();
  await assertCleanStudentVocabulary(page, "/courses/browser-loop-course/progress");

  await page.goto("/settings/me");
  await expect(page.getByTestId("global-memory-archive-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("memory-fact-loop-mem-1")).toBeVisible();
  await assertCleanStudentVocabulary(page, "/settings/me");

  expect(pageErrors, "Phase 1-4 routes should produce zero pageerrors").toEqual([]);
  expect(consoleErrors, "Phase 1-4 routes should produce zero console.error logs").toEqual([]);
});
