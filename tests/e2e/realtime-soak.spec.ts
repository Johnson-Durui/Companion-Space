import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type CDPSession,
  type Page,
  type TestInfo,
} from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8200";
const storageRoot = path.resolve(
  process.cwd(),
  process.env.E2E_SOAK_STORAGE_ROOT ?? ".playwright/soak-storage",
);
const vaultPassword = "m7-soak-pass";
const mockTranscript = "这是一段用于联调语音链路的模拟转写。";
const canaryFrame = Buffer.from(
  Array.from({ length: 640 }, (_, index) => (index * 73 + 41) % 256),
);
const forbiddenAudioExtensions = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".pcm",
  ".raw",
  ".wav",
  ".webm",
]);
const binaryAudioMarkers = [
  Buffer.from("RIFF", "ascii"),
  Buffer.from("WAVE", "ascii"),
  Buffer.from("audio/pcm", "ascii"),
];
const mockTtsPcmMarker = Buffer.from(
  Array.from({ length: 480 }, (_, index) => {
    const waveform = [0, 900, 1_800, 900, 0, -900, -1_800, -900];
    const value = waveform[index % waveform.length] ?? 0;
    return [value & 0xff, (value >> 8) & 0xff];
  }).flat(),
);

const browserHeapThresholdMb = 32;
const browserProcessRssThresholdMb = 128;
const apiRssThresholdMb = 96;
const soakMinutes = positiveNumberFromEnv("E2E_SOAK_MINUTES", 30);
const sampleIntervalMs = positiveNumberFromEnv("E2E_SOAK_SAMPLE_SECONDS", 30) * 1_000;
const turnIntervalMs = positiveNumberFromEnv("E2E_SOAK_TURN_SECONDS", 15) * 1_000;
const durationMs = soakMinutes * 60 * 1_000;

type RealtimeFixture = {
  callPath: string;
  spaceId: string;
  spaceName: string;
};

type MemorySample = {
  apiDeltaMb: number;
  apiRssMb: number;
  browserDeltaMb: number;
  browserHeapMb: number;
  browserProcessDeltaMb: number;
  browserProcessRssMb: number;
  elapsedMs: number;
  observedAt: string;
  reportedDeltaMb: number;
};

type ResidueFinding = {
  file: string;
  reason: string;
};

const defaultRecipe = {
  avatar_model: "vrm1_constraint_twist_sample",
  base_model: "mini",
  face_style: "soft",
  hairstyle: "short_bob",
  outfit: "academy",
  accessories: [],
  palette: {
    skin_tone: "#f3d3c3",
    hair_color: "#5d718d",
    eye_color: "#9ed2ff",
    outfit_color: "#29354a",
    accent_color: "#77d7d1",
  },
  personality: "gentle",
  warmth: 72,
  initiative: 58,
  humor: 44,
  challenge: 34,
  relationship_role: "friend",
  voice_provider: "mock",
  voice_model: "mock-voice",
  voice_id: "default",
  speaking_rate: 1,
  motions: {},
};

test.describe("production realtime soak", () => {
  test.skip(
    process.env.E2E_RUN_SOAK !== "1",
    "The 30-minute release soak only runs through the dedicated npm script.",
  );

  test("keeps one audio session stable and leaves no raw audio residue", async ({ page, context, browser }, testInfo) => {
    test.setTimeout(Math.max(5 * 60 * 1_000, durationMs + 5 * 60 * 1_000));

    const ownerToken = await initializeAndUnlockVault(page);
    const fixture = await createRealtimeFixture(page.request, ownerToken);
    // Headless Chromium uses a software WebGL renderer. The dedicated hardware
    // lane covers VRM performance; the long-running lane isolates realtime and
    // audio memory by exercising the product's supported 2D fallback.
    await page.route("**/*.vrm", async (route) => route.abort("failed"));
    await installRealtimeHarness(page);
    await openCallPage(page, fixture);
    await expect(page.getByTestId("avatar-fallback")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "开始语音" }).click();
    await expect(page.getByText("connected")).toBeVisible({ timeout: 20_000 });

    const cdp = await context.newCDPSession(page);
    const browserCdp = await browser.newBrowserCDPSession();
    await cdp.send("HeapProfiler.enable");
    const sessionId = await getCapturedSessionId(page);
    const samples: MemorySample[] = [];
    let turnCount = 0;
    let residueFindings: ResidueFinding[] = [];

    for (let warmup = 0; warmup < 3; warmup += 1) {
      await runAudioTurn(page, sessionId, fixture.spaceId);
      turnCount += 1;
    }

    const baseline = await readMemory(cdp, browserCdp);
    const startedAt = Date.now();
    samples.push(toMemorySample(baseline, baseline, 0));
    await postMetric(page.request, ownerToken, {
      event: "soak_memory_delta_mb",
      session_id: sessionId,
      value: 0,
    });

    let nextSampleAt = startedAt + sampleIntervalMs;
    let nextTurnAt = startedAt;
    while (Date.now() - startedAt < durationMs) {
      const now = Date.now();
      if (now >= nextSampleAt) {
        const current = await readMemory(cdp, browserCdp);
        const sample = toMemorySample(current, baseline, Date.now() - startedAt);
        samples.push(sample);
        await postMetric(page.request, ownerToken, {
          event: "soak_memory_delta_mb",
          session_id: sessionId,
          value: sample.reportedDeltaMb,
        });
        nextSampleAt += sampleIntervalMs;
        continue;
      }
      if (now >= nextTurnAt) {
        await runAudioTurn(page, sessionId, fixture.spaceId);
        turnCount += 1;
        nextTurnAt = Date.now() + turnIntervalMs;
        continue;
      }
      await page.waitForTimeout(Math.min(250, nextTurnAt - now, nextSampleAt - now));
    }

    const finalMemory = await readMemory(cdp, browserCdp);
    const finalSample = toMemorySample(finalMemory, baseline, Date.now() - startedAt);
    samples.push(finalSample);
    await postMetric(page.request, ownerToken, {
      event: "soak_memory_delta_mb",
      session_id: sessionId,
      value: finalSample.reportedDeltaMb,
    });

    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);

    residueFindings = await scanForAudioResidue(storageRoot);
    await postMetric(page.request, ownerToken, {
      event: "audio_residue_scan",
      session_id: sessionId,
      residue_found: residueFindings.length > 0,
    });

    const summaryResponse = await page.request.get(`${apiBaseUrl}/api/v1/metrics/local/summary`, {
      headers: ownerHeaders(ownerToken),
    });
    expect(summaryResponse.ok()).toBeTruthy();
    const summary = await summaryResponse.json() as {
      performance: {
        audio_residue_scan: { clean: number; residue_found: number };
        soak_memory_delta_mb: { count: number };
      };
    };

    const browserLeak = detectsBrowserLeak(samples);
    const browserProcessLeak = detectsBrowserProcessLeak(samples);
    const apiLeak = detectsApiLeak(samples);
    await attachEvidence(testInfo, {
      apiLeak,
      apiRssThresholdMb,
      browserHeapThresholdMb,
      browserLeak,
      browserProcessLeak,
      browserProcessRssThresholdMb,
      durationMs,
      residueFindings,
      sampleIntervalMs,
      samples,
      sessionId,
      turnCount,
      turnIntervalMs,
    });

    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(turnCount).toBeGreaterThanOrEqual(4);
    expect(browserLeak, "Chromium post-GC heap showed sustained growth.").toBeFalsy();
    expect(browserProcessLeak, "Chromium process RSS showed sustained growth.").toBeFalsy();
    expect(apiLeak, "FastAPI RSS showed sustained growth.").toBeFalsy();
    expect(residueFindings).toEqual([]);
    expect(summary.performance.soak_memory_delta_mb.count).toBeGreaterThanOrEqual(samples.length);
    expect(summary.performance.audio_residue_scan.residue_found).toBe(0);
    expect(summary.performance.audio_residue_scan.clean).toBeGreaterThanOrEqual(1);
  });
});

function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

async function installRealtimeHarness(page: Page) {
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        if (/\/api\/v1\/sessions\/[^/]+\/realtime$/.test(socket.url)) {
          Object.assign(window, { __e2eRealtimeSocket: socket });
        }
        return socket;
      },
    });

    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          const AudioContextCtor = window.AudioContext || (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }).webkitAudioContext;
          if (!AudioContextCtor) {
            throw new Error("Web Audio is unavailable in this browser.");
          }
          const audioContext = new AudioContextCtor();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          gain.gain.value = 0;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();
          await audioContext.resume();
          Object.assign(window, { __e2eSoakMicContext: audioContext, __e2eSoakMicOscillator: oscillator });
          return destination.stream;
        },
      },
    });
  });
}

async function getCapturedSessionId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
      .__e2eRealtimeSocket;
    const encodedSessionId = socket
      ? /\/sessions\/([^/]+)\/realtime$/.exec(socket.url)?.[1]
      : undefined;
    if (!socket || socket.readyState !== WebSocket.OPEN || !encodedSessionId) {
      throw new Error("Realtime WebSocket was not captured in an open state.");
    }
    return decodeURIComponent(encodedSessionId);
  });
}

async function runAudioTurn(
  page: Page,
  expectedSessionId: string,
  expectedSpaceId: string,
): Promise<void> {
  const expectedTranscript = mockTranscript;
  const canary = Array.from(canaryFrame);
  await page.evaluate(
    ({ bytes, sessionId, spaceId, transcript }) => new Promise<void>((resolve, reject) => {
      const socket = (window as typeof window & { __e2eRealtimeSocket?: WebSocket })
        .__e2eRealtimeSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Realtime WebSocket was not captured in an open state."));
        return;
      }
      const encodedSessionId = /\/sessions\/([^/]+)\/realtime$/.exec(socket.url)?.[1];
      if (!encodedSessionId) {
        reject(new Error("Realtime session id was not present in the WebSocket URL."));
        return;
      }

      let sawAsrPartial = false;
      let sawAsrFinal = false;
      let sawLlmFinal = false;
      const timeout = window.setTimeout(() => {
        socket.removeEventListener("message", handleMessage);
        reject(new Error("Realtime audio turn did not complete within 30 seconds."));
      }, 30_000);
      const fail = (message: string) => {
        window.clearTimeout(timeout);
        socket.removeEventListener("message", handleMessage);
        reject(new Error(message));
      };
      const handleMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          return;
        }
        let payload: {
          session_id?: unknown;
          type?: unknown;
          payload?: {
            audio_bytes?: unknown;
            buffered_audio_bytes?: unknown;
            detail?: unknown;
            final?: unknown;
            session_id?: unknown;
            space_id?: unknown;
            text?: unknown;
          };
        };
        try {
          payload = JSON.parse(event.data) as typeof payload;
        } catch {
          return;
        }
        if (payload.type === "error") {
          fail(`Realtime server error: ${String(payload.payload?.detail ?? "unknown")}`);
          return;
        }
        if (payload.session_id !== sessionId) {
          fail("Realtime event escaped the active soak session.");
          return;
        }
        if (payload.type === "asr.partial") {
          if (payload.payload?.buffered_audio_bytes !== bytes.length) {
            fail("Realtime server did not buffer the complete PCM frame.");
            return;
          }
          sawAsrPartial = true;
        }
        if (payload.type === "asr.final") {
          if (
            !sawAsrPartial
            || payload.payload?.text !== transcript
            || payload.payload?.audio_bytes !== bytes.length
          ) {
            fail("Mock STT did not commit the complete PCM frame.");
            return;
          }
          sawAsrFinal = true;
        }
        if (payload.type === "llm.final") {
          if (
            payload.payload?.session_id !== sessionId
            || payload.payload?.space_id !== spaceId
          ) {
            fail("CompanionTurn escaped the active soak space or session.");
            return;
          }
          sawLlmFinal = true;
        }
        if (payload.type === "tts.chunk" && payload.payload?.final === true) {
          if (!sawAsrFinal || !sawLlmFinal) {
            fail("Realtime events completed out of contract order.");
            return;
          }
          window.clearTimeout(timeout);
          socket.removeEventListener("message", handleMessage);
          resolve();
        }
      };
      socket.addEventListener("message", handleMessage);
      socket.send(new Uint8Array(bytes));
      socket.send(JSON.stringify({
        type: "user.commit",
        session_id: decodeURIComponent(encodedSessionId),
        state: "listening",
        payload: {},
      }));
    }),
    {
      bytes: canary,
      sessionId: expectedSessionId,
      spaceId: expectedSpaceId,
      transcript: expectedTranscript,
    },
  );

  const playbackMeter = page.locator("[data-playback-level]").first();
  await expect.poll(async () => {
    const level = await playbackMeter.getAttribute("data-playback-level");
    return Number.parseFloat(level ?? "0");
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  const stopLatencyMs = await page.getByRole("button", { name: "立即打断" }).evaluate(
    (button) => new Promise<number>((resolve, reject) => {
      const meter = document.querySelector<HTMLElement>("[data-playback-level]");
      if (!meter) {
        reject(new Error("Playback meter was not found."));
        return;
      }
      const startedAt = performance.now();
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Playback did not stop within one second."));
      }, 1_000);
      const finishIfStopped = () => {
        if (Number.parseFloat(meter.dataset.playbackLevel ?? "0") > 0) {
          return;
        }
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve(performance.now() - startedAt);
      };
      const observer = new MutationObserver(finishIfStopped);
      observer.observe(meter, { attributes: true, attributeFilter: ["data-playback-level"] });
      (button as HTMLButtonElement).click();
      finishIfStopped();
    }),
  );
  expect(stopLatencyMs).toBeLessThanOrEqual(250);
  await expect(playbackMeter).toHaveAttribute("data-playback-level", "0");
  await expect(page.getByText("connected")).toBeVisible();
}

type RawMemoryReading = {
  apiRssMb: number;
  browserHeapMb: number;
  browserProcessRssMb: number;
};

async function readMemory(
  cdp: CDPSession,
  browserCdp: CDPSession,
): Promise<RawMemoryReading> {
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage") as { usedSize: number };
  const pid = (await readFile(path.join(storageRoot, "api.pid"), "utf8")).trim();
  if (!/^\d+$/.test(pid)) {
    throw new Error("Soak API PID file did not contain a numeric process id.");
  }
  const processInfo = await browserCdp.send("SystemInfo.getProcessInfo") as {
    processInfo: Array<{ id: number; type: string }>;
  };
  const browserProcessRss = [...new Set(processInfo.processInfo.map((item) => item.id))]
    .map((processId) => tryReadRssMb(String(processId)))
    .filter((value): value is number => value !== null);
  if (browserProcessRss.length === 0) {
    throw new Error("Could not read RSS for any Chromium process.");
  }
  return {
    apiRssMb: readRssMb(pid, "soak API"),
    browserHeapMb: heap.usedSize / (1_024 * 1_024),
    browserProcessRssMb: browserProcessRss.reduce((total, value) => total + value, 0),
  };
}

function readRssMb(pid: string, label: string): number {
  const rssMb = tryReadRssMb(pid);
  if (rssMb === null) {
    throw new Error(`Could not read RSS for ${label} process ${pid}.`);
  }
  return rssMb;
}

function tryReadRssMb(pid: string): number | null {
  const result = spawnSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const rssKb = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(rssKb) && rssKb > 0 ? rssKb / 1_024 : null;
}

function toMemorySample(
  current: RawMemoryReading,
  baseline: RawMemoryReading,
  elapsedMs: number,
): MemorySample {
  const apiDeltaMb = current.apiRssMb - baseline.apiRssMb;
  const browserDeltaMb = current.browserHeapMb - baseline.browserHeapMb;
  const browserProcessDeltaMb = current.browserProcessRssMb - baseline.browserProcessRssMb;
  return {
    apiDeltaMb,
    apiRssMb: current.apiRssMb,
    browserDeltaMb,
    browserHeapMb: current.browserHeapMb,
    browserProcessDeltaMb,
    browserProcessRssMb: current.browserProcessRssMb,
    elapsedMs,
    observedAt: new Date().toISOString(),
    reportedDeltaMb: Math.max(0, apiDeltaMb, browserDeltaMb, browserProcessDeltaMb),
  };
}

function detectsBrowserLeak(samples: MemorySample[]): boolean {
  const deltas = samples.map((sample) => sample.browserDeltaMb);
  return detectsSustainedOrUnrecoveredGrowth(
    samples,
    deltas,
    browserHeapThresholdMb,
    (sample) => sample.browserDeltaMb,
  );
}

function detectsApiLeak(samples: MemorySample[]): boolean {
  const rollingMedians = samples.map((_, index) => {
    const window = samples
      .slice(Math.max(0, index - 2), index + 1)
      .map((sample) => sample.apiDeltaMb);
    return median(window);
  });
  return detectsSustainedOrUnrecoveredGrowth(
    samples,
    rollingMedians,
    apiRssThresholdMb,
    (sample) => sample.apiDeltaMb,
  );
}

function detectsBrowserProcessLeak(samples: MemorySample[]): boolean {
  const rollingMedians = samples.map((_, index) => median(
    samples
      .slice(Math.max(0, index - 2), index + 1)
      .map((sample) => sample.browserProcessDeltaMb),
  ));
  return detectsSustainedOrUnrecoveredGrowth(
    samples,
    rollingMedians,
    browserProcessRssThresholdMb,
    (sample) => sample.browserProcessDeltaMb,
  );
}

function detectsSustainedOrUnrecoveredGrowth(
  samples: MemorySample[],
  deltas: number[],
  threshold: number,
  select: (sample: MemorySample) => number,
): boolean {
  const slope = recentSlope(samples, select);
  const finalWindow = deltas.slice(-3);
  const unrecoveredFinal = finalWindow.length === 3
    && finalWindow.every((value) => value > threshold)
    && slope >= 0;
  return (sustainedAboveThreshold(deltas, threshold) && slope > 0) || unrecoveredFinal;
}

function sustainedAboveThreshold(values: number[], threshold: number): boolean {
  return values.some((value, index) => index >= 2
    && value > threshold
    && values[index - 1] > threshold
    && values[index - 2] > threshold);
}

function recentSlope(samples: MemorySample[], select: (sample: MemorySample) => number): number {
  if (samples.length < 2) {
    return 0;
  }
  const finalElapsed = samples.at(-1)?.elapsedMs ?? 0;
  const recent = samples.filter((sample) => sample.elapsedMs >= Math.max(0, finalElapsed - 10 * 60 * 1_000));
  if (recent.length < 2) {
    return 0;
  }
  const xs = recent.map((sample) => sample.elapsedMs / 60_000);
  const ys = recent.map(select);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const denominator = xs.reduce((total, value) => total + (value - xMean) ** 2, 0);
  if (denominator === 0) {
    return 0;
  }
  return xs.reduce(
    (total, value, index) => total + (value - xMean) * ((ys[index] ?? yMean) - yMean),
    0,
  ) / denominator;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function scanForAudioResidue(root: string): Promise<ResidueFinding[]> {
  const findings: ResidueFinding[] = [];
  for (const file of await listFiles(root)) {
    const relativeFile = path.relative(root, file);
    if (forbiddenAudioExtensions.has(path.extname(file).toLowerCase())) {
      findings.push({ file: relativeFile, reason: "forbidden audio file extension" });
    }
    const content = await readFile(file);
    if (content.indexOf(canaryFrame) >= 0) {
      findings.push({ file: relativeFile, reason: "uploaded PCM canary bytes persisted" });
    }
    if (content.indexOf(mockTtsPcmMarker) >= 0) {
      findings.push({ file: relativeFile, reason: "downloaded Mock TTS PCM bytes persisted" });
    }
    for (const marker of binaryAudioMarkers) {
      if (content.indexOf(marker) >= 0) {
        findings.push({ file: relativeFile, reason: `audio marker ${marker.toString("ascii")} persisted` });
      }
    }
    if (path.basename(file) === "api.log" && content.includes(Buffer.from(mockTranscript, "utf8"))) {
      findings.push({ file: relativeFile, reason: "final transcript was written to API logs" });
    }
  }
  return findings;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function attachEvidence(testInfo: TestInfo, evidence: object): Promise<void> {
  const evidencePath = testInfo.outputPath("soak-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await testInfo.attach("soak-evidence", {
    path: evidencePath,
    contentType: "application/json",
  });
}

async function initializeAndUnlockVault(page: Page): Promise<string> {
  await page.goto("/vault");
  const statusLabels = page.locator(".status-badge");
  await expect(page.getByRole("form", { name: /^Vault (初始化|解锁)$/ })).toHaveCount(1);
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.status()).toBe(200);
  const vaultStatus = await statusResponse.json() as { initialized?: unknown };
  let ownerToken: string | null = null;

  if (vaultStatus.initialized !== true) {
    await page.getByLabel("初始化主密码").fill(vaultPassword);
    const initResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/init") && response.request().method() === "POST");
    await page.getByRole("button", { name: "初始化 Vault" }).click();
    ownerToken = ((await (await initResponse).json()) as { owner_token?: string | null }).owner_token ?? null;
  } else {
    await page.getByLabel("解锁主密码").fill(vaultPassword);
    const unlockResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/unlock") && response.request().method() === "POST");
    await page.getByRole("button", { name: "解锁" }).click();
    ownerToken = ((await (await unlockResponse).json()) as { owner_token?: string | null }).owner_token ?? null;
  }

  await expect(statusLabels.filter({ hasText: "Yes" })).toHaveCount(2);
  expect(ownerToken).toBeTruthy();
  return ownerToken as string;
}

async function createRealtimeFixture(request: APIRequestContext, ownerToken: string): Promise<RealtimeFixture> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const space = await postJson(request, "/api/v1/spaces", ownerToken, {
    name: `Soak 空间 ${runId}`,
    topic: "生产模式实时稳定性",
    goal: "验证连续实时语音会话没有内存泄漏或音频残留",
  });
  const character = await postJson(request, "/api/v1/characters", ownerToken, {
    name: `Soak Nova ${runId}`,
    description: "Release soak character",
    recipe: defaultRecipe,
  });
  await putJson(request, `/api/v1/spaces/${space.id}`, ownerToken, {
    name: space.name,
    topic: space.topic,
    goal: space.goal,
    default_character_pack_id: character.id,
  });
  await postJson(request, `/api/v1/spaces/${space.id}/assignments`, ownerToken, {
    capability: "stt",
    provider_connection_id: "builtin-mock",
    model_name: "mock-stt-v1",
  });
  await postJson(request, `/api/v1/spaces/${space.id}/assignments`, ownerToken, {
    capability: "tts",
    provider_connection_id: "builtin-mock",
    model_name: "mock-voice-v1",
  });
  return {
    callPath: `/spaces/${space.id}/call`,
    spaceId: space.id,
    spaceName: space.name,
  };
}

async function openCallPage(page: Page, fixture: RealtimeFixture): Promise<void> {
  await Promise.all([
    page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
    page.getByRole("link", { name: "学习空间" }).first().click(),
  ]);
  const spaceCard = page.locator("article.info-card").filter({ hasText: fixture.spaceName });
  await expect(spaceCard).toBeVisible({ timeout: 20_000 });
  await Promise.all([
    page.waitForURL(new RegExp(`/spaces/${fixture.spaceId}$`), { timeout: 20_000 }),
    spaceCard.getByRole("link", { name: "进入空间" }).click(),
  ]);
  await Promise.all([
    page.waitForURL(fixture.callPath, { timeout: 20_000 }),
    page.getByRole("link", { name: "开始伴学会话" }).click(),
  ]);
}

async function postJson(
  request: APIRequestContext,
  route: string,
  ownerToken: string,
  payload: unknown,
): Promise<any> {
  const response = await request.post(`${apiBaseUrl}${route}`, {
    data: payload,
    headers: ownerHeaders(ownerToken),
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function putJson(
  request: APIRequestContext,
  route: string,
  ownerToken: string,
  payload: unknown,
): Promise<any> {
  const response = await request.put(`${apiBaseUrl}${route}`, {
    data: payload,
    headers: ownerHeaders(ownerToken),
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function postMetric(
  request: APIRequestContext,
  ownerToken: string,
  payload: unknown,
): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/api/v1/metrics/local/signals`, {
    data: payload,
    headers: ownerHeaders(ownerToken),
  });
  expect(response.status()).toBe(204);
}

function ownerHeaders(ownerToken: string): Record<string, string> {
  return { Authorization: `Bearer ${ownerToken}` };
}
