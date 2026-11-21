import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const webDir = resolve(root, "apps/web");
const args = process.argv.slice(2);
const serveOnly = args.includes("--serve");
const milestone = args.find((arg) => !arg.startsWith("--")) ?? "U1";
const port = Number(process.env.GALLERY_PORT ?? "5179");
const galleryUrl = `http://127.0.0.1:${port}/tests/ui-gallery/index.html`;

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite dev server did not respond at ${url}`);
}

const vite = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: webDir,
    stdio: serveOnly ? "inherit" : "pipe",
    shell: process.platform === "win32",
  },
);

if (serveOnly) {
  console.log(`UI Gallery running at: ${galleryUrl}`);
  process.on("SIGINT", () => {
    vite.kill();
    process.exit(0);
  });
} else {
  const outDir = resolve(root, "docs/rebuild/review", milestone, "gallery");
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".png")) unlinkSync(resolve(outDir, name));
  }

  try {
    await waitForServer(galleryUrl);
    const channel = process.env.PLAYWRIGHT_CHANNEL || "msedge";
    const browser = await chromium.launch({ channel, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const shots = [
      { file: "01-gallery-bundled-desk.png", query: "?font=bundled&surface=desk&theme=default", fullPage: true },
      { file: "02-font-bundled-specimen.png", query: "?font=bundled&surface=desk&theme=default", selector: '[data-testid="font-specimen"]' },
      { file: "03-font-system-specimen.png", query: "?font=system&surface=desk&theme=default", selector: '[data-testid="font-specimen"]' },
      { file: "04-gallery-stage-xuechuan.png", query: "?font=bundled&surface=stage&theme=xuechuan", fullPage: false },
      { file: "05-gallery-paper-chutang.png", query: "?font=bundled&surface=paper&theme=chutang", fullPage: false },
      { file: "06-gallery-lanyue.png", query: "?font=bundled&surface=desk&theme=lanyue", fullPage: false },
      { file: "07-gallery-qingheng.png", query: "?font=bundled&surface=desk&theme=qingheng", fullPage: false },
    ];

    for (const shot of shots) {
      await page.goto(`${galleryUrl}${shot.query}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const target = resolve(outDir, shot.file);
      if (shot.selector) {
        await page.locator(shot.selector).screenshot({ path: target });
      } else {
        await page.screenshot({ path: target, fullPage: Boolean(shot.fullPage) });
      }
      console.log(`Captured ${shot.file}`);
    }

    await browser.close();
  } finally {
    vite.kill();
  }
}
