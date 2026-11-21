// Self-bootstrapping UI screenshot tour against the local fixture server (port 8732).
// Usage: npm run review:tour -- U0
// Do not run concurrently with `npm run test:e2e`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  // ---------- A. welcome ----------
  await step("welcome", async () => {
    await page.goto("/welcome");
    await page.getByTestId("teacher-stage").waitFor({ timeout: 15_000 });
    await settle(1200);
    await shot(page, "welcome-desktop");
    await shot(page, "welcome-desktop-full", { full: true });
  });
  await step("welcome pick another teacher", async () => {
    await page.getByRole("region", { name: t.welcome.label }).getByRole("button").nth(3).click();
    await settle(900);
    await shot(page, "welcome-other-teacher");
  });
  await step("welcome voice preview", async () => {
    await button(page, t.voice.preview).click();
    await settle(1200);
    await shot(page, "welcome-voice-preview");
  });

  // ---------- B. courses (3+ courses, empty course noPlan, stress course) + new course flow ----------
  await step("courses list", async () => {
    await page.goto("/courses");
    await page.getByRole("heading", { name: t.courses.heading }).waitFor({ timeout: 15_000 });
    await page.getByTestId("course-card").nth(2).waitFor({ timeout: 10_000 });
    await settle();
    await shot(page, "courses-list");
    await shot(page, "courses-list-full", { full: true });
  });
  await step("courses new form", async () => {
    await button(page, t.courses.new).first().click();
    await settle();
    await shot(page, "courses-new-form");
    await page.getByLabel(t.courses.name).fill("高一数学 · 函数");
    await page.getByLabel(t.courses.goal).fill("期末考试前把二次函数与最值弄明白");
    await button(page, t.courses.create).click();
    await page.getByRole("heading", { name: "高一数学 · 函数" }).waitFor({ timeout: 15_000 });
    await settle(800);
    await shot(page, "course-new-workspace");
    await shot(page, "course-new-workspace-full", { full: true });
  });

  const textbook = Buffer.from("# 条件关系\n\n已知一个条件成立时，可以依据规则判断相应结果。\n\n## 结果计算\n\n先识别条件，再把信息代入规则完成计算。", "utf8");
  const exam = Buffer.from("# 2025 阶段测试\n\n1. 根据材料，正确结果是哪一项？\n\nA. 不成立\nB. 成立\n\n答案：B（10 分）", "utf8");
  await step("course add files", async () => {
    await page.getByLabel(t.courses.choose).setInputFiles([
      { name: "课堂笔记.md", mimeType: "text/markdown", buffer: textbook },
      { name: "2025阶段真题含答案.md", mimeType: "text/markdown", buffer: exam },
    ]);
    await page.getByTestId("pending-file").first().waitFor({ timeout: 8_000 });
    await settle();
    await shot(page, "course-pending-files");
    await button(page, t.courses.upload).click();
    await page.getByTestId("material-item").first().waitFor({ timeout: 15_000 });
    await settle(800);
    await shot(page, "course-materials-uploaded", { full: true });
  });
  await step("course analysis", async () => {
    await button(page, t.courses.start).click();
    await settle(400);
    await shot(page, "course-analysis-estimate");
    const confirm = button(page, t.courses.confirmStart);
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.getByRole("progressbar").first().waitFor({ timeout: 15_000 });
    await shot(page, "course-analysis-running");
    await page.getByTestId("analysis-summary").filter({ hasText: t.courses.jobStatus.completed }).waitFor({ timeout: 45_000 });
    await settle(1000);
    await shot(page, "course-analysis-done-full", { full: true });
  });
  await step("course map", async () => {
    await page.getByRole("heading", { name: t.courses.mapHeading }).scrollIntoViewIfNeeded();
    await settle();
    await shot(page, "course-map");
    const exams = page.getByRole("button", { name: /查看关联真题/ });
    if (await exams.first().isVisible().catch(() => false)) {
      await exams.first().click();
      await settle();
      await shot(page, "course-map-exam-browser");
    }
    await button(page, t.courses.revise).first().click();
    await settle();
    await shot(page, "course-map-revise");
  });
  const coursePath = new URL(page.url()).pathname;
  note(`new course path: ${coursePath}`);

  await step("learner setup + journey", async () => {
    await page.goto(coursePath);
    await page.getByRole("heading", { name: "高一数学 · 函数" }).waitFor({ timeout: 15_000 });
    await settle(800);
    const heading = page.getByText(t.learner.heading, { exact: true }).first();
    await heading.scrollIntoViewIfNeeded();
    await heading.click();
    await settle();
    await shot(page, "learner-setup");
    await shot(page, "course-with-setup-full", { full: true });
  });
  await step("learner interview", async () => {
    const journey = page.getByRole("heading", { name: t.learner.journeyHeading });
    await journey.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await settle();
    await shot(page, "learner-journey");
    for (let round = 0; round < 8; round += 1) {
      const useSaved = button(page, t.learner.useSavedValues);
      const next = button(page, t.learner.interviewNext);
      if (await useSaved.isVisible().catch(() => false)) await useSaved.click();
      else if (await next.isVisible().catch(() => false)) await next.click();
      else break;
      await settle(700);
      if (round === 0) await shot(page, "learner-interview-step2");
    }
    await settle(900);
    await shot(page, "learner-after-interview");
    await shot(page, "learner-after-interview-full", { full: true });
  });
  await step("placement", async () => {
    const heading = page.getByText(t.learner.placementHeading, { exact: true }).first();
    await heading.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await settle();
    await shot(page, "placement");
    for (let round = 0; round < 6; round += 1) {
      const dontKnow = button(page, t.learner.dontKnow);
      if (!(await dontKnow.isVisible().catch(() => false))) break;
      await dontKnow.click();
      await settle(700);
    }
    const enough = button(page, t.learner.enough);
    if (await enough.isVisible().catch(() => false)) {
      await enough.click();
      await settle(700);
    }
    await shot(page, "placement-result");
  });
  await step("build plan", async () => {
    const build = button(page, t.learner.buildPlan);
    await build.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await build.click();
    await settle(1800);
    await shot(page, "plan-built");
    await shot(page, "plan-built-full", { full: true });
  });

  // ---------- C. seeded "today", empty, and stress content scenarios ----------
  for (const [name, path] of [
    ["today-course", "/courses/browser-today-course"],
    ["progress", "/courses/browser-today-course/progress"],
    ["review", "/courses/browser-today-course/review"],
    ["course-history", "/courses/browser-today-course/history"],
    ["practice", "/plan-items/browser-today-lesson-item/practice"],
    ["empty-course", "/courses/browser-empty-course"],
    ["stress-course-map", "/courses/browser-stress-course"],
  ]) {
    await step(name, async () => {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 15_000 });
      await settle(1200);
      await shot(page, name);
      await shot(page, `${name}-full`, { full: true });
    });
  }

  await step("empty-course placement wait materials", async () => {
    await page.goto("/courses/browser-empty-course");
    await page.getByText(t.learner.heading, { exact: true }).first().click();
    await button(page, t.learner.interviewSkip).waitFor({ timeout: 10_000 });
    await button(page, t.learner.interviewSkip).click();
    await page.getByText(t.learner.placementWaitMaterials, { exact: true }).waitFor({ timeout: 10_000 });
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
    await shot(page, "stress-lesson-question-full", { full: true });
  });

  // ---------- D. classroom: full lesson ----------
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
    await page.getByText(t.classroom.more, { exact: true }).click();
    await settle(400);
    await shot(page, "lesson-more-open");
    await page.getByText(t.classroom.more, { exact: true }).click();
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
    await button(page, t.classroom.startText).click();
    await settle(2000);
  });
  await step("lesson end + recap", async () => {
    await button(page, t.classroom.end).click();
    await page.getByRole("heading", { name: t.classroom.recap }).waitFor({ timeout: 25_000 });
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
    ["m-welcome", "/welcome"],
    ["m-courses", "/courses"],
    ["m-course", coursePath],
    ["m-stress-course", "/courses/browser-stress-course"],
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
