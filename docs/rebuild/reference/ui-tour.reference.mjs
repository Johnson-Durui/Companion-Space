// 截图巡览参考脚本（2026-11-21 已在本机对测试夹具跑通，产出 73 张截图）。
// 用法：先启动测试夹具服务（services/api/tests/e2e_server.py，端口由环境变量 E2E_API_PORT 指定），
//       再运行 node ui-tour.reference.mjs <仓库根目录> <输出目录> <服务地址>。
// U0 任务 2 要求把它改造成 tests/e2e/ui-tour.mjs：自己拉起夹具、接收输出目录名，并在界面改版后同步更新步骤。
// 本机没有 Playwright 自带浏览器时会依次尝试 msedge 与 chrome。截图只供人工评审，不作为断言。

// Walk the running fixture app and capture every key screen/state for a UI audit.
// Usage: node capture.mjs <repoRoot> <outDir> <baseURL>
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, out, base] = process.argv.slice(2);
const require = createRequire(pathToFileURL(join(repo, "package.json")));
const { chromium } = require("playwright");
const t = JSON.parse(readFileSync(join(repo, "apps/web/src/locales/zh-CN.json"), "utf8"));
mkdirSync(out, { recursive: true });

const log = [];
const note = (line) => { log.push(line); console.log(line); };

async function launch() {
  for (const options of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
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

const browser = await launch();
const desktop = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await desktop.newPage();
page.on("dialog", (dialog) => void dialog.accept());
page.on("pageerror", (error) => note(`pageerror: ${error.message}`));

let counter = 0;
async function shot(target, name, { full = false } = {}) {
  counter += 1;
  const file = `${String(counter).padStart(2, "0")}-${name}.png`;
  try {
    await target.screenshot({ path: join(out, file), fullPage: full, animations: "disabled" });
    const size = await target.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, vh: window.innerHeight }));
    note(`shot ${file} page=${size.w}x${size.h} viewport-h=${size.vh}`);
  } catch (error) {
    note(`shot FAILED ${file}: ${String(error).split("\n")[0]}`);
  }
}
async function step(label, fn) {
  try {
    await fn();
    note(`ok   ${label}`);
    return true;
  } catch (error) {
    note(`FAIL ${label}: ${String(error).split("\n")[0]}`);
    return false;
  }
}
const button = (target, name, exact = true) => target.getByRole("button", { name, exact });
const settle = (ms = 700) => page.waitForTimeout(ms);

// ---------- A. welcome ----------
await step("welcome", async () => {
  await page.goto("/welcome");
  await page.locator(".teacher-stage").waitFor({ timeout: 15000 });
  await settle(1500);
  await shot(page, "welcome-desktop");
  await shot(page, "welcome-desktop-full", { full: true });
});
await step("welcome pick another teacher", async () => {
  await page.locator(".roster-option").nth(3).click();
  await settle(1200);
  await shot(page, "welcome-other-teacher");
});
await step("welcome voice preview", async () => {
  await button(page, t.voice.preview).click();
  await settle(1500);
  await shot(page, "welcome-voice-preview");
});

// ---------- B. courses + new course flow ----------
await step("courses list", async () => {
  await page.goto("/courses");
  await page.getByRole("heading", { name: t.courses.heading }).waitFor({ timeout: 15000 });
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
  await page.getByRole("heading", { name: "高一数学 · 函数" }).waitFor({ timeout: 15000 });
  await settle(1000);
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
  await page.locator(".pending-file").first().waitFor({ timeout: 8000 });
  await settle();
  await shot(page, "course-pending-files");
  await button(page, t.courses.upload).click();
  await page.locator(".material-list article").first().waitFor({ timeout: 15000 });
  await settle(1000);
  await shot(page, "course-materials-uploaded", { full: true });
});
await step("course analysis", async () => {
  await button(page, t.courses.start).click();
  await settle(500);
  await shot(page, "course-analysis-estimate");
  const confirm = button(page, t.courses.confirmStart);
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.locator(".analysis-progress progress").waitFor({ timeout: 15000 });
  await shot(page, "course-analysis-running");
  await page.locator(".analysis-summary").filter({ hasText: t.courses.jobStatus.completed }).waitFor({ timeout: 45000 });
  await settle(1200);
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
  await page.getByRole("heading", { name: "高一数学 · 函数" }).waitFor({ timeout: 15000 });
  await settle(1000);
  const heading = page.getByText(t.learner.heading, { exact: true }).first();
  await heading.scrollIntoViewIfNeeded();
  await heading.click();
  await settle();
  await shot(page, "learner-setup");
  await shot(page, "course-with-setup-full", { full: true });
});
await step("learner interview", async () => {
  const journey = page.getByRole("heading", { name: t.learner.journeyHeading });
  await journey.scrollIntoViewIfNeeded({ timeout: 5000 });
  await settle();
  await shot(page, "learner-journey");
  for (let round = 0; round < 8; round += 1) {
    const next = button(page, t.learner.interviewNext);
    const useSaved = button(page, t.learner.useSavedValues);
    if (await useSaved.isVisible().catch(() => false)) await useSaved.click();
    else if (await next.isVisible().catch(() => false)) await next.click();
    else break;
    await settle(900);
    if (round === 0) await shot(page, "learner-interview-step2");
  }
  await settle(1200);
  await shot(page, "learner-after-interview");
  await shot(page, "learner-after-interview-full", { full: true });
});
await step("placement", async () => {
  const heading = page.getByRole("heading", { name: t.learner.placementHeading });
  await heading.scrollIntoViewIfNeeded({ timeout: 5000 });
  await settle();
  await shot(page, "placement");
  for (let round = 0; round < 6; round += 1) {
    const dontKnow = button(page, t.learner.dontKnow);
    if (!(await dontKnow.isVisible().catch(() => false))) break;
    await dontKnow.click();
    await settle(900);
  }
  const enough = button(page, t.learner.enough);
  if (await enough.isVisible().catch(() => false)) { await enough.click(); await settle(900); }
  await shot(page, "placement-result");
});
await step("build plan", async () => {
  const build = button(page, t.learner.buildPlan);
  await build.scrollIntoViewIfNeeded({ timeout: 5000 });
  await build.click();
  await settle(2500);
  await shot(page, "plan-built");
  await shot(page, "plan-built-full", { full: true });
});

// ---------- C. seeded "today" course surfaces ----------
for (const [name, path] of [
  ["today-course", "/courses/browser-today-course"],
  ["progress", "/courses/browser-today-course/progress"],
  ["review", "/courses/browser-today-course/review"],
  ["course-history", "/courses/browser-today-course/history"],
  ["practice", "/plan-items/browser-today-lesson-item/practice"],
]) {
  await step(name, async () => {
    await page.goto(path);
    await settle(1800);
    await shot(page, name);
    await shot(page, `${name}-full`, { full: true });
  });
}

// ---------- D. classroom: full lesson ----------
await step("lesson prestart", async () => {
  await page.goto("/lessons/browser-voice-lesson");
  await button(page, t.classroom.startText).waitFor({ timeout: 15000 });
  await settle(1500);
  await shot(page, "lesson-prestart");
});
await step("lesson teaching", async () => {
  await button(page, t.classroom.startText).click();
  await page.getByText("先确认已知条件。", { exact: true }).first().waitFor({ timeout: 20000 });
  await shot(page, "lesson-teaching");
  await page.getByRole("radio", { name: "A 按条件推导" }).waitFor({ timeout: 25000 });
  await settle(800);
  await shot(page, "lesson-question");
  await shot(page, "lesson-question-full", { full: true });
});
await step("lesson quick actions", async () => {
  await page.locator(".lesson-quick details summary").click();
  await settle(400);
  await shot(page, "lesson-more-open");
  await page.locator(".lesson-quick details summary").click();
});
await step("lesson answer correct", async () => {
  await page.getByRole("radio", { name: "A 按条件推导" }).check();
  await settle(300);
  await shot(page, "lesson-option-selected");
  await button(page, t.classroom.submitAnswer).click();
  await page.getByRole("status").filter({ hasText: t.classroom.verdicts.correct }).waitFor({ timeout: 20000 });
  await settle(600);
  await shot(page, "lesson-verdict-correct");
  await settle(4000);
  await shot(page, "lesson-after-verdict");
  await shot(page, "lesson-after-verdict-full", { full: true });
});
await step("lesson pause", async () => {
  await button(page, t.classroom.pause).click();
  await settle(1200);
  await shot(page, "lesson-paused");
  await button(page, t.classroom.startText).click();
  await settle(2500);
});
await step("lesson end + recap", async () => {
  await button(page, t.classroom.end).click();
  await page.getByRole("heading", { name: t.classroom.recap }).waitFor({ timeout: 25000 });
  await settle(800);
  await shot(page, "lesson-recap");
  await shot(page, "lesson-recap-full", { full: true });
  await page.getByRole("link", { name: t.history.replay }).click();
  await settle(1800);
  await shot(page, "lesson-history-replay");
  await shot(page, "lesson-history-replay-full", { full: true });
});
await step("board blocks", async () => {
  await page.goto("/lessons/browser-board-lesson");
  await button(page, t.classroom.startText).click({ timeout: 15000 });
  await page.locator('[data-kind="plot"] svg').waitFor({ timeout: 20000 });
  await settle(2500);
  await shot(page, "board-blocks");
  await shot(page, "board-blocks-full", { full: true });
});
await step("lesson incorrect", async () => {
  await page.goto("/lessons/browser-avatar-incorrect-lesson");
  await button(page, t.classroom.startText).click({ timeout: 15000 });
  await page.getByRole("radio", { name: "B 忽略条件" }).check({ timeout: 25000 });
  await button(page, t.classroom.submitAnswer).click();
  await page.getByRole("status").filter({ hasText: t.classroom.verdicts.incorrect }).waitFor({ timeout: 20000 });
  await settle(500);
  await shot(page, "lesson-verdict-incorrect");
  await settle(3500);
  await shot(page, "lesson-after-incorrect-full", { full: true });
});

// ---------- E. sample lesson ----------
await step("sample lesson", async () => {
  await page.goto("/sample-lesson");
  await settle(2000);
  await shot(page, "sample-initial");
  await shot(page, "sample-initial-full", { full: true });
  await button(page, t.history.play).click();
  await settle(9000);
  await shot(page, "sample-playing");
  await settle(20000);
  await shot(page, "sample-later");
  await shot(page, "sample-later-full", { full: true });
});

// ---------- F. characters + settings ----------
await step("characters", async () => {
  await page.goto("/characters");
  await settle(2500);
  await shot(page, "characters");
  await shot(page, "characters-full", { full: true });
  await button(page, t.characters.poses.praise).click();
  await settle(900);
  await shot(page, "characters-pose-praise");
});
await step("settings", async () => {
  await page.goto("/settings");
  await settle(2500);
  await shot(page, "settings");
  await shot(page, "settings-full", { full: true });
});
await step("diagnostics", async () => {
  await page.goto("/settings/diagnostics");
  await settle(1500);
  await shot(page, "diagnostics");
});

// ---------- G. mobile ----------
const mobileContext = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const mobile = await mobileContext.newPage();
mobile.on("dialog", (dialog) => void dialog.accept());
for (const [name, path] of [
  ["m-welcome", "/welcome"],
  ["m-courses", "/courses"],
  ["m-course", coursePath],
  ["m-settings", "/settings"],
]) {
  await step(name, async () => {
    await mobile.goto(path);
    await mobile.waitForTimeout(2000);
    await shot(mobile, name);
    await shot(mobile, `${name}-full`, { full: true });
  });
}
await step("m-lesson", async () => {
  await mobile.goto("/lessons/browser-avatar-teaching-lesson");
  await button(mobile, t.classroom.startText).waitFor({ timeout: 15000 });
  await mobile.waitForTimeout(1200);
  await shot(mobile, "m-lesson-prestart");
  await button(mobile, t.classroom.startText).click();
  await mobile.getByRole("radio", { name: "A 按条件推导" }).waitFor({ timeout: 25000 });
  await mobile.waitForTimeout(800);
  await shot(mobile, "m-lesson-question");
  await shot(mobile, "m-lesson-question-full", { full: true });
});

writeFileSync(join(out, "capture-log.txt"), log.join("\n"), "utf8");
await browser.close();
