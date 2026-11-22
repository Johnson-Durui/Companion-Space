// Self-bootstrapping UI screenshot tour against the local fixture server (port 8732).
// Usage: npm run review:tour -- U0
// Do not run concurrently with `npm run test:e2e`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const distIndex = join(repo, "apps/web/dist/index.html");
if (!existsSync(distIndex)) {
  console.error("Missing frontend build artifact: apps/web/dist/index.html");
  console.error("Run `npm run build --workspace web` before running `npm run review:tour`.");
  process.exit(1);
}

const rawOut = process.argv[2] ?? "U0";
const out = isAbsolute(rawOut) || rawOut.includes("/") || rawOut.includes("\\")
  ? resolve(repo, rawOut)
  : join(repo, "docs/rebuild/review", rawOut);
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) {
  if (entry.endsWith(".png")) unlinkSync(join(out, entry));
}

const port = process.env.REVIEW_TOUR_PORT ?? "8732";
const base = `http://127.0.0.1:${port}`;
const venv = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const python = existsSync(join(repo, venv)) ? join(repo, venv) : "python";

const require = createRequire(pathToFileURL(join(repo, "package.json")));
const { chromium } = require("playwright");
const t = JSON.parse(readFileSync(join(repo, "apps/web/src/locales/zh-CN.json"), "utf8"));

const log = [];
const note = (line) => { log.push(line); console.log(line); };

function startFixtureServer() {
  const serverLog = [];
  const child = spawn(python, ["services/api/tests/e2e_server.py"], {
    cwd: repo,
    env: { ...process.env, PYTHONPATH: "services/api", E2E_API_PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => serverLog.push(String(chunk)));
  child.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));
  return { child, serverLog };
}

async function waitForHealth(child, serverLog, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fixture server exited early (${child.exitCode}): ${serverLog.join("").slice(-600)}`);
    }
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) {
        const body = await response.json();
        if (body?.ok) return;
      }
    } catch {
      // Server still booting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for fixture server at ${base}/healthz`);
}

function stopFixtureServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // Ignore kill error and use platform fallback.
  }
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

async function launch() {
  const preferred = process.env.PLAYWRIGHT_CHANNEL
    ? [{ channel: process.env.PLAYWRIGHT_CHANNEL }, {}, { channel: "msedge" }, { channel: "chrome" }]
    : [{}, { channel: "msedge" }, { channel: "chrome" }];
  for (const options of preferred) {
    try {
      const browser = await chromium.launch({ ...options, args: ["--autoplay-policy=no-user-gesture-required"] });
      note(`browser: ${JSON.stringify(options)}`);
      return browser;
    } catch (error) {
      note(`launch failed ${JSON.stringify(options)}: ${String(error).split("\n")[0]}`);
    }
  }
  throw new Error("no browser available");
}

const { child: server, serverLog } = startFixtureServer();
let browser;
let passed = 0;
let failures = 0;
let counter = 0;

try {
  await waitForHealth(server, serverLog);
  note(`fixture server ready at ${base}`);
  browser = await launch();
  const desktop = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await desktop.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  page.on("pageerror", (error) => {
    failures += 1;
    note(`pageerror: ${error.message}`);
  });

  async function shot(target, name, { full = false } = {}) {
    counter += 1;
    const file = `${String(counter).padStart(2, "0")}-${name}.png`;
    try {
      await target.screenshot({ path: join(out, file), fullPage: full, animations: "disabled" });
      const size = await target.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        vh: window.innerHeight,
      }));
      note(`shot ${file} page=${size.w}x${size.h} viewport-h=${size.vh}`);
    } catch (error) {
      failures += 1;
      note(`shot FAILED ${file}: ${String(error).split("\n")[0]}`);
    }
  }

  async function step(label, fn) {
    try {
      await fn();
      passed += 1;
      note(`ok   ${label}`);
      return true;
    } catch (error) {
      failures += 1;
      note(`FAIL ${label}: ${String(error).split("\n")[0]}`);
      return false;
    }
  }

  const button = (target, name, exact = true) => target.getByRole("button", { name, exact });
  const settle = (ms = 600) => page.waitForTimeout(ms);

  // ---------- A. today + onboarding + tutors ----------
  await step("today", async () => {
    await page.goto("/");
    await page.getByTestId("today-page").waitFor({ timeout: 15_000 });
    await settle(900);
    await shot(page, "today-desktop");
    await shot(page, "today-desktop-full", { full: true });
  });
  await step("welcome onboarding", async () => {
    await page.goto("/welcome");
    await page.getByTestId("teacher-stage").waitFor({ timeout: 15_000 });
    await settle(900);
    await shot(page, "welcome-desktop");
    await shot(page, "welcome-desktop-full", { full: true });
  });
  await step("tutors picker", async () => {
    await page.goto("/tutors");
    await page.getByTestId("teacher-stage").waitFor({ timeout: 15_000 });
    await page.getByRole("region", { name: t.welcome.label }).getByRole("button").nth(3).click();
    await settle(900);
    await shot(page, "tutors-other-teacher");
    await button(page, t.voice.preview).click();
    await settle(900);
    await shot(page, "tutors-voice-preview");
  });

  // ---------- B. courses (3+ courses, empty course, stress course) + 5-step setup flow ----------
  await step("courses list", async () => {
    await page.goto("/courses");
    await page.getByRole("heading", { name: t.courses.heading }).waitFor({ timeout: 15_000 });
    await page.getByTestId("course-card").nth(2).waitFor({ timeout: 10_000 });
    await settle();
    await shot(page, "courses-list");
    await shot(page, "courses-list-full", { full: true });
  });
  let courseId = "";
  await step("courses new dialog -> setup", async () => {
    await button(page, t.courses.new).first().click();
    await settle();
    await shot(page, "courses-new-dialog");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(t.courses.name).fill("高一数学 · 函数");
    await dialog.getByLabel(t.courses.goal).fill("期末考试前把二次函数与最值弄明白");
    await dialog.getByRole("button", { name: t.courses.create }).click();
    await page.getByTestId("course-setup").waitFor({ timeout: 15_000 });
    courseId = new URL(page.url()).pathname.split("/")[2];
    await settle(700);
    await shot(page, "setup-step1-materials");
  });

  const textbook = Buffer.from("# 条件关系\n\n已知一个条件成立时，可以依据规则判断相应结果。\n\n## 结果计算\n\n先识别条件，再把信息代入规则完成计算。", "utf8");
  const exam = Buffer.from("# 2025 阶段测试\n\n1. 根据材料，正确结果是哪一项？\n\nA. 不成立\nB. 成立\n\n答案：B（10 分）", "utf8");
  await step("setup upload + connect wizard + analysis", async () => {
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "课堂笔记.md", mimeType: "text/markdown", buffer: textbook },
      { name: "2025阶段真题含答案.md", mimeType: "text/markdown", buffer: exam },
    ]);
    await page.getByTestId("pending-file").first().waitFor({ timeout: 8_000 });
    await settle();
    await shot(page, "setup-pending-files");
    const uploadOnly = button(page, t.setup.uploadOnly);
    if (await uploadOnly.isVisible().catch(() => false)) {
      await uploadOnly.click();
      await page.getByTestId("material-item").first().waitFor({ timeout: 15_000 });
      await button(page, t.setup.connectToRead).click();
      await page.getByTestId("connect-wizard").waitFor({ timeout: 10_000 });
      await settle();
      await shot(page, "connect-wizard-step1");
      await page.getByTestId("preset-card-bigmodel").click();
      await settle();
      await shot(page, "connect-wizard-step2");
      await page.getByLabel(t.connectWizard.keyLabel).fill("fixture-tour-key");
      await button(page, t.connectWizard.saveAndTest).click();
      await button(page, t.connectWizard.done).waitFor({ timeout: 15_000 });
      await settle();
      await shot(page, "connect-wizard-done");
      await button(page, t.connectWizard.done).click();
    } else {
      await button(page, t.setup.handToTeacher).click();
    }
    await page.getByTestId("setup-analysis-step").waitFor({ timeout: 15_000 });
    await shot(page, "setup-step2-reading");
    await page.getByRole("heading", { name: t.setup.readingDoneTitle }).waitFor({ timeout: 45_000 });
    await settle(700);
    await shot(page, "setup-step2-done");
  });

  await step("setup interview -> placement -> plan reveal", async () => {
    await page.goto(`/courses/${courseId}/setup?step=interview`);
    const interviewBox = page.getByTestId("setup-interview-step");
    await interviewBox.waitFor({ timeout: 15_000 });
    await settle(700);
    await shot(page, "setup-step3-interview");
    for (let round = 0; round < 6; round += 1) {
      const knownYes = interviewBox.getByRole("button", { name: t.setup.knownYes });
      if (await knownYes.isVisible().catch(() => false)) {
        await knownYes.click();
      } else {
        const cont = interviewBox.getByRole("button", { name: t.onboarding.continue });
        if (!(await cont.isVisible().catch(() => false))) break;
        await cont.click();
      }
      await settle(400);
    }
    await page.goto(`/courses/${courseId}/setup?step=placement`);
    await settle(700);
    await shot(page, "setup-step4-placement");
    for (let round = 0; round < 5; round += 1) {
      const dontKnow = button(page, t.learner.dontKnow);
      if (!(await dontKnow.isVisible().catch(() => false))) break;
      await dontKnow.click();
      await settle(500);
    }
    const enough = button(page, t.learner.enough);
    if (await enough.isVisible().catch(() => false)) {
      await enough.click();
      await settle(600);
    }
    await shot(page, "setup-step4-done");
    const buildBtn = button(page, t.setup.step4BuildPlan);
    if (await buildBtn.isVisible().catch(() => false)) {
      await buildBtn.click();
    } else {
      await page.goto(`/courses/${courseId}/setup?step=plan`);
      const build2 = button(page, t.learner.buildPlan);
      if (await build2.isVisible().catch(() => false)) await build2.click();
    }
    await page.getByTestId("setup-plan-step").waitFor({ timeout: 15_000 });
    await settle(700);
    await shot(page, "setup-step5-plan-reveal");
    await shot(page, "setup-step5-plan-reveal-full", { full: true });
  });

  await step("course hub plan + map + materials", async () => {
    await page.goto(`/courses/${courseId}/plan`);
    await page.getByTestId("course-plan-page").waitFor({ timeout: 15_000 });
    await settle(600);
    const whyBtn = page.getByRole("button", { name: t.planView.whyToggle }).first();
    if (await whyBtn.isVisible().catch(() => false)) await whyBtn.click();
    await settle(300);
    await shot(page, "course-plan");
    await shot(page, "course-plan-full", { full: true });

    await page.goto(`/courses/${courseId}/map`);
    await page.getByRole("heading", { name: t.courses.mapHeading }).waitFor({ timeout: 15_000 });
    await settle(600);
    await shot(page, "course-map");
    await page.goto(`/courses/${courseId}/materials`);
    await page.getByTestId("course-materials-tab").waitFor({ timeout: 15_000 });
    await settle(600);
    await shot(page, "course-materials");
  });

  // ---------- C. seeded "today", empty, and stress content scenarios ----------
  for (const [name, path] of [
    ["today-course", "/courses/browser-today-course"],
    ["today-course-plan", "/courses/browser-today-course/plan"],
    ["progress", "/courses/browser-today-course/progress"],
    ["review", "/courses/browser-today-course/review"],
    ["course-history", "/courses/browser-today-course/history"],
    ["practice", "/plan-items/browser-today-lesson-item/practice"],
    ["empty-course", "/courses/browser-empty-course"],
    ["stress-course-map", "/courses/browser-stress-course/map"],
  ]) {
    await step(name, async () => {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 15_000 });
      await settle(900);
      await shot(page, name);
      await shot(page, `${name}-full`, { full: true });
    });
  }

  await step("empty-course placement locked (wait materials)", async () => {
    await page.goto("/courses/browser-empty-course/setup?step=placement");
    await page.getByTestId("placement-locked").waitFor({ timeout: 10_000 });
    await settle();
    await shot(page, "empty-course-placement-wait");
  });

  await step("stress lesson (long title, 22-line formulas, 3-line stem, 6 long options)", async () => {
    await page.goto("/lessons/browser-stress-lesson");
    await button(page, t.classroom.startText).waitFor({ timeout: 15_000 });
    await button(page, t.classroom.startText).click();
    await page.getByRole("radio", { name: /^F / }).waitFor({ timeout: 25_000 });
    await settle(800);
    await shot(page, "stress-lesson-question");
    await page.setViewportSize({ width: 1280, height: 720 });
    await settle(400);
    await shot(page, "stress-lesson-question-1280x720");
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(300);
    await shot(page, "stress-lesson-question-full", { full: true });
  });

  // ---------- D. classroom lobby + full lesson ----------
  await step("lesson lobby (unprepared -> ready + warmup)", async () => {
    await page.goto("/plan-items/browser-unprepared-item/lesson");
    await page.getByTestId("lesson-lobby").waitFor({ timeout: 15_000 });
    await settle(200);
    await shot(page, "lesson-lobby-preparing");
    await page.getByTestId("lobby-outline").waitFor({ timeout: 20_000 });
    await settle(600);
    await shot(page, "lesson-lobby-ready");
  });
  await step("lesson prestart", async () => {
    await page.goto("/lessons/browser-voice-lesson");
    await button(page, t.classroom.startText).waitFor({ timeout: 15_000 });
    await settle(1200);
    await shot(page, "lesson-prestart");
  });
  await step("lesson teaching", async () => {
    await button(page, t.classroom.startText).click();
    await page.getByText("先确认已知条件。", { exact: true }).first().waitFor({ timeout: 20_000 });
    await shot(page, "lesson-teaching");
    await page.getByRole("radio", { name: "A 按条件推导" }).waitFor({ timeout: 25_000 });
    await settle(700);
    await shot(page, "lesson-question");
    await shot(page, "lesson-question-full", { full: true });
  });
  await step("lesson quick actions", async () => {
    await button(page, t.classroom.moreActions).click();
    await settle(400);
    await shot(page, "lesson-more-open");
    await page.keyboard.press("Escape");
  });
  await step("lesson answer correct", async () => {
    await page.getByRole("radio", { name: "A 按条件推导" }).check();
    await settle(300);
    await shot(page, "lesson-option-selected");
    await button(page, t.classroom.submitAnswer).click();
    await page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct }).waitFor({ timeout: 20_000 });
    await settle(600);
    await shot(page, "lesson-verdict-correct");
    await settle(3000);
    await shot(page, "lesson-after-verdict");
    await shot(page, "lesson-after-verdict-full", { full: true });
  });
  await step("lesson pause", async () => {
    await button(page, t.classroom.pause).click();
    await settle(1000);
    await shot(page, "lesson-paused");
    await button(page, t.classroom.resumeLesson).click();
    await settle(2000);
  });
  await step("lesson end + recap", async () => {
    await button(page, t.classroom.end).click();
    await page.getByRole("alertdialog").waitFor({ timeout: 10_000 });
    await settle(300);
    await shot(page, "lesson-end-confirm");
    await page.getByRole("alertdialog").getByRole("button", { name: t.classroom.confirmEnd }).click();
    await page.getByTestId("lesson-recap").waitFor({ timeout: 25_000 });
    await settle(700);
    await shot(page, "lesson-recap");
    await shot(page, "lesson-recap-full", { full: true });
    await page.getByRole("link", { name: t.history.replay }).click();
    await settle(1500);
    await shot(page, "lesson-history-replay");
    await shot(page, "lesson-history-replay-full", { full: true });
  });
  await step("board blocks (chinese render error)", async () => {
    await page.goto("/lessons/browser-board-lesson");
    await button(page, t.classroom.startText).click({ timeout: 15_000 });
    await page.locator('[data-kind="plot"] svg').waitFor({ timeout: 20_000 });
    await page.locator('[data-kind="diagram"]').filter({ hasText: t.classroom.boardRenderError }).waitFor({ timeout: 20_000 });
    await settle(1000);
    await shot(page, "board-blocks");
    await shot(page, "board-blocks-full", { full: true });
  });
  await step("lesson incorrect + confused (comfort reaction, no praise)", async () => {
    await page.goto("/lessons/browser-avatar-incorrect-lesson");
    await button(page, t.classroom.startText).click({ timeout: 15_000 });
    await page.getByRole("radio", { name: "B 忽略条件" }).waitFor({ timeout: 25_000 });
    await button(page, t.classroom.quick.confused).click();
    await settle(400);
    await shot(page, "lesson-confused-comfort");
    await page.getByRole("radio", { name: "B 忽略条件" }).check({ timeout: 25_000 });
    await button(page, t.classroom.submitAnswer).click();
    await page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect }).waitFor({ timeout: 20_000 });
    await settle(400);
    await shot(page, "lesson-verdict-incorrect");
    await settle(3000);
    await shot(page, "lesson-after-incorrect-full", { full: true });
  });

  // ---------- E. sample lesson ----------
  await step("sample lesson", async () => {
    await page.goto("/sample-lesson");
    await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 15_000 });
    await settle(1500);
    await shot(page, "sample-initial");
    await shot(page, "sample-initial-full", { full: true });
    await button(page, t.history.play).click();
    await settle(6000);
    await shot(page, "sample-playing");
  });

  // ---------- F. characters + settings + 404 ----------
  await step("characters", async () => {
    await page.goto("/characters");
    await page.getByRole("heading", { name: t.characters.heading }).waitFor({ timeout: 15_000 });
    await settle(1500);
    await shot(page, "characters");
    await shot(page, "characters-full", { full: true });
    await button(page, t.characters.poses.praise).click();
    await settle(700);
    await shot(page, "characters-pose-praise");
  });
  await step("settings", async () => {
    await page.goto("/settings");
    await page.getByRole("heading", { name: t.settings.heading }).waitFor({ timeout: 15_000 });
    await settle(1500);
    await shot(page, "settings");
    await shot(page, "settings-full", { full: true });
  });
  await step("diagnostics", async () => {
    await page.goto("/settings/diagnostics");
    await page.getByRole("heading", { name: t.diagnostics.heading }).waitFor({ timeout: 15_000 });
    await settle(1000);
    await shot(page, "diagnostics");
  });
  await step("not-found 404", async () => {
    await page.goto("/this-route-does-not-exist-404");
    await page.getByRole("heading", { name: t.app.notFoundTitle }).waitFor({ timeout: 15_000 });
    await settle(600);
    await shot(page, "not-found-404");
  });

  // ---------- G. mobile (390x844) ----------
  const mobileContext = await browser.newContext({
    baseURL: base,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const mobile = await mobileContext.newPage();
  mobile.on("dialog", (dialog) => void dialog.accept());
  mobile.on("pageerror", (error) => {
    failures += 1;
    note(`mobile pageerror: ${error.message}`);
  });
  for (const [name, path] of [
    ["m-today", "/"],
    ["m-welcome", "/welcome"],
    ["m-courses", "/courses"],
    ["m-course", courseId ? `/courses/${courseId}` : "/courses/browser-today-course"],
    ["m-stress-course", "/courses/browser-stress-course/map"],
    ["m-settings", "/settings"],
  ]) {
    await step(name, async () => {
      await mobile.goto(path);
      await mobile.getByRole("heading", { level: 1 }).waitFor({ timeout: 15_000 });
      await mobile.waitForTimeout(1200);
      await shot(mobile, name);
      await shot(mobile, `${name}-full`, { full: true });
    });
  }
  await step("m-lesson", async () => {
    await mobile.goto("/lessons/browser-avatar-teaching-lesson");
    await button(mobile, t.classroom.startText).waitFor({ timeout: 15_000 });
    await mobile.waitForTimeout(1000);
    await shot(mobile, "m-lesson-prestart");
    await button(mobile, t.classroom.startText).click();
    await mobile.getByRole("radio", { name: "A 按条件推导" }).waitFor({ timeout: 25_000 });
    await mobile.waitForTimeout(700);
    await shot(mobile, "m-lesson-question");
    await shot(mobile, "m-lesson-question-full", { full: true });
  });

  note(`summary: ${passed} passed, ${failures} failed, ${counter} screenshots -> ${out}`);
} finally {
  writeFileSync(join(out, "capture-log.txt"), log.join("\n"), "utf8");
  if (browser) await browser.close().catch(() => undefined);
  stopFixtureServer(server);
}

if (failures > 0) {
  console.error(`UI tour completed with ${failures} failure(s). See ${join(out, "capture-log.txt")}`);
  process.exit(1);
}
