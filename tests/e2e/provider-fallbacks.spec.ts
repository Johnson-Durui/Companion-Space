import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const vaultPassword = "m7-playwright-pass";
const testQuestion = "请给我一个最小模型推导的例子。";
const providerSlug = "ollama";

interface RealtimeFixture {
  callPath: string;
  spaceId: string;
  spaceName: string;
}

type StubScenario = "auth" | "rate-limited" | "stream-break";

type StubState = {
  mode: StubScenario;
  chatCompletionsCalls: number;
};

let providerStub: Server | null = null;
let providerStubPort = 0;
const stubState: StubState = {
  mode: "auth",
  chatCompletionsCalls: 0,
};

function setStubMode(mode: StubScenario) {
  stubState.mode = mode;
  stubState.chatCompletionsCalls = 0;
}

function getProviderStubPort() {
  return providerStubPort;
}

function getChatCompletionCalls() {
  return stubState.chatCompletionsCalls;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunk = "";
    request.on("data", (chunkPart) => {
      chunk += chunkPart.toString("utf8");
    });
    request.on("error", (error) => {
      reject(error);
    });
    request.on("end", () => {
      resolve(chunk);
    });
  });
}

function parsePath(rawUrl: string | null) {
  return (rawUrl ?? "").split("?")[0] ?? "/";
}

function sendJson(response: ServerResponse, status: number, payload: object) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function handleProviderRequest(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const path = parsePath(request.url ?? "/");

  if (method === "GET" && path === "/v1/models") {
    sendJson(response, 200, { data: [{ id: "stub-chat", object: "model" }] });
    return;
  }

  if (method === "POST" && path === "/v1/chat/completions") {
    stubState.chatCompletionsCalls += 1;
    await readRequestBody(request);

    if (stubState.mode === "auth") {
      sendJson(response, 401, {
        error: { message: "unauthorized" },
      });
      return;
    }

    if (stubState.mode === "rate-limited") {
      response.statusCode = 429;
      response.setHeader("retry-after", "12");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          message: "rate limited",
        },
      }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "keep-alive",
    });
    response.write('data: {"choices":[{"delta":{"content":"{\\\"display_text\\\":\\\"partial"}}]}\n\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    response.socket?.destroy();
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

function startProviderStub(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    providerStub = createServer((request, response) => {
      void handleProviderRequest(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(`provider stub error: ${String(error)}`);
      });
    });
    providerStub.on("error", reject);
    providerStub.listen(0, "127.0.0.1", () => {
      providerStubPort = (providerStub?.address() as AddressInfo).port;
      resolve(providerStubPort);
    });
  });
}

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

test.beforeAll(async () => {
  await startProviderStub();
  test.setTimeout(120_000);
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!providerStub) {
      resolve();
      return;
    }
    providerStub.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

const scenarios = [
  {
    expectedCode: "provider_authentication_failed",
    expectedError: "Authentication failed",
    expectedStatus: 424,
    mode: "auth" as const,
    title: "401 authentication",
  },
  {
    expectedCode: "provider_rate_limited",
    expectedError: "Provider rate limit reached",
    expectedStatus: 429,
    mode: "rate-limited" as const,
    title: "429 rate limit",
  },
  {
    expectedCode: "provider_unavailable",
    expectedError: "The provider is unavailable",
    expectedStatus: 200,
    streamStarted: true,
    mode: "stream-break" as const,
    title: "upstream stream break",
  },
];

for (const scenario of scenarios) {
  test(`provider fallback (${scenario.title}) keeps draft and retry path`, async ({ page }) => {
    test.setTimeout(120_000);
    setStubMode(scenario.mode);

    const ownerToken = await initializeAndUnlockVault(page);
    const fixture = await createFallbackFixture(page.request, ownerToken);
    await openCallPage(page, fixture);

    const draftInput = page.getByLabel("发送文字消息");
    await draftInput.fill(testQuestion);

    const beforeUserTurns = await page.locator('[data-role="user"]').count();
    const beforeAssistantTurns = await page.locator('[data-role="assistant"]').count();

    const send = async () => {
      const sendResponse = page.waitForResponse((response) => {
        return response.url().includes("/api/v1/sessions/") && response.url().endsWith("/turns/stream") && response.request().method() === "POST";
      });
      await page.getByRole("button", { name: "发送文本" }).click();
      return sendResponse;
    };

    const response = await send();
    expect(response.status()).toBe(scenario.expectedStatus);
    if (!("streamStarted" in scenario)) {
      const payload = await response.json();
      expect(payload.code).toBe(scenario.expectedCode);
      expect(payload.detail).toContain(`${providerSlug}: ${scenario.expectedError}`);
    }

    await expect(page.getByText(scenario.expectedError, { exact: false })).toBeVisible();
    await expect(page.getByText(`（${scenario.expectedCode}）`, { exact: false })).toBeVisible();
    await expect(draftInput).toHaveValue(testQuestion);
    await expect(page.getByRole("button", { name: "发送文本" })).toBeEnabled();
    await expect(page.locator('[data-role="user"]')).toHaveCount(beforeUserTurns + 1);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(beforeAssistantTurns);
    await expect(page.locator('[data-role="user"]').last()).toContainText(testQuestion);

    const response2 = await send();
    expect(response2.status()).toBe(scenario.expectedStatus);
    if (!("streamStarted" in scenario)) {
      const payload2 = await response2.json();
      expect(payload2.code).toBe(scenario.expectedCode);
    }
    await expect(page.getByText(`（${scenario.expectedCode}）`, { exact: false })).toBeVisible();
    expect(await draftInput.inputValue()).toBe(testQuestion);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(beforeAssistantTurns);
    await expect(page.locator('[data-role="user"]')).toHaveCount(beforeUserTurns + 2);
    expect(getChatCompletionCalls()).toBe(2);

    await expect(page.getByText("模拟回复")).toHaveCount(0);
  });
}

async function initializeAndUnlockVault(page: Page) {
  await page.goto("/vault");

  const statusLabels = page.locator(".status-badge");
  await expect(page.getByRole("form", { name: /^Vault (初始化|解锁)$/ })).toHaveCount(1);
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.ok()).toBeTruthy();
  const vaultStatus = await statusResponse.json() as { initialized?: unknown };
  let ownerToken: string | null;

  if (vaultStatus.initialized !== true) {
    await page.getByLabel("初始化主密码").fill(vaultPassword);
    const initResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/init") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "初始化 Vault" }).click();
    const response = await initResponse;
    expect(response.ok()).toBeTruthy();
    ownerToken = ((await response.json()) as { owner_token?: string | null }).owner_token ?? null;
  } else {
    await page.getByLabel("解锁主密码").fill(vaultPassword);
    const unlockResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/unlock") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "解锁" }).click();
    const response = await unlockResponse;
    expect(response.ok()).toBeTruthy();
    ownerToken = ((await response.json()) as { owner_token?: string | null }).owner_token ?? null;
  }

  await expect(statusLabels.filter({ hasText: "Yes" })).toHaveCount(2, { timeout: 10_000 });
  expect(ownerToken).toBeTruthy();
  return ownerToken as string;
}

async function createFallbackFixture(
  request: APIRequestContext,
  token: string,
): Promise<RealtimeFixture> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const spaceResponse = await request.post(`${apiBaseUrl}/api/v1/spaces`, {
    data: {
      name: `Provider Fallback 空间 ${runId}`,
      topic: "回退行为回归",
      goal: "检验供应商回退场景是否保留输入和重试。",
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(spaceResponse.ok()).toBeTruthy();
  const space = await spaceResponse.json() as { id: string; name: string };

  const connectionResponse = await request.post(`${apiBaseUrl}/api/v1/providers/connections`, {
    data: {
      // Ollama intentionally permits local endpoints; using it here keeps the
      // production SSRF guard for arbitrary OpenAI-compatible URLs intact.
      provider: providerSlug,
      label: `Fallback Stub ${runId}`,
      api_key: "",
      base_url: `http://127.0.0.1:${getProviderStubPort()}/v1`,
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(connectionResponse.ok()).toBeTruthy();
  const connection = await connectionResponse.json() as { id: string };

  const charResponse = await request.post(`${apiBaseUrl}/api/v1/characters`, {
    data: {
      name: `Fallback 学习伴侣 ${runId}`,
      description: "用于回退回归的测试角色",
      recipe: defaultRecipe,
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(charResponse.ok()).toBeTruthy();
  const character = await charResponse.json() as { id: string };

  await request.put(`${apiBaseUrl}/api/v1/spaces/${space.id}`, {
    data: {
      name: space.name,
      topic: "回退行为回归",
      goal: "检验供应商回退场景是否保留输入和重试。",
      default_character_pack_id: character.id,
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const assignmentResponse = await request.post(`${apiBaseUrl}/api/v1/spaces/${space.id}/assignments`, {
    data: {
      capability: "chat_llm",
      provider_connection_id: connection.id,
      model_name: "stub-chat",
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(assignmentResponse.ok()).toBeTruthy();

  return {
    spaceId: space.id,
    callPath: `/spaces/${space.id}/call`,
    spaceName: space.name,
  };
}

async function openCallPage(page: Page, fixture: RealtimeFixture) {
  const spacesLink = page.getByRole("link", { name: "学习空间" }).first();
  await Promise.all([
    page.waitForURL(/\/spaces$/, { timeout: 20_000 }),
    spacesLink.click(),
  ]);

  const spaceCard = page.locator("article.info-card").filter({ hasText: fixture.spaceName });
  await expect(spaceCard).toBeVisible({ timeout: 20_000 });
  await Promise.all([
    page.waitForURL(new RegExp(`/spaces/${fixture.spaceId}$`), { timeout: 20_000 }),
    spaceCard.getByRole("link", { name: "进入空间" }).click(),
  ]);

  await Promise.all([
    page.waitForURL(fixture.callPath, { timeout: 60_000, waitUntil: "domcontentloaded" }),
    page.getByRole("link", { name: "开始伴学会话" }).click(),
  ]);
}
