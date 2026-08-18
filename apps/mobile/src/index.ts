type AuthResponse = {
  refresh_token: string;
  access_token: string;
  access_token_expires_at: string;
  rotation_id?: string;
  device: { id: string; name: string };
};

type CompanionAuthPlugin = {
  persistAuth(options: {
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    accessTokenExpiresAtEpochMs: number;
    serverOrigin: string;
    rotationId?: string;
  }): Promise<void>;
  getRefreshToken(): Promise<{ value: string | null; rotationId?: string | null }>;
  getAccessToken(): Promise<{ value: string | null; expiresAt?: string | null }>;
  refreshAccessToken(): Promise<{ value: string | null; expiresAt?: string | null }>;
  clearAccessToken(): Promise<void>;
  clearAuth(): Promise<void>;
  returnToLauncher(): Promise<void>;
};

declare global {
  interface Window {
    __COMPANION_TRUSTED_ORIGINS__?: string[];
    __COMPANION_ALLOW_HTTP_LOCALHOST__?: boolean;
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: {
        Preferences?: {
          get(options: { key: string }): Promise<{ value: string | null }>;
          set(options: { key: string; value: string }): Promise<void>;
        };
        CompanionAuth?: CompanionAuthPlugin;
      };
    };
  }
}

const originStorageKey = "companion.mobile.serverOrigin";
const trustedOrigins = new Set(window.__COMPANION_TRUSTED_ORIGINS__ ?? []);
const allowHttpLocalhost = window.__COMPANION_ALLOW_HTTP_LOCALHOST__ === true;
const form = document.querySelector<HTMLFormElement>("#connection-form")!;
const input = document.querySelector<HTMLInputElement>("#server-url")!;
const codeInput = document.querySelector<HTMLInputElement>("#pairing-code")!;
const deviceInput = document.querySelector<HTMLInputElement>("#device-name")!;
const button = document.querySelector<HTMLButtonElement>("#connect-button")!;
const message = document.querySelector<HTMLElement>("#message")!;
const statusLabel = document.querySelector<HTMLElement>("#status-label")!;
const panel = document.querySelector<HTMLElement>(".connection")!;
const pairingFields = document.querySelector<HTMLElement>("#pairing-fields")!;
const trustedList = document.querySelector<HTMLElement>("#trusted-origins")!;

class ApiFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function authPlugin(): CompanionAuthPlugin | null {
  if (window.Capacitor?.isNativePlatform?.() !== true) return null;
  return window.Capacitor.Plugins?.CompanionAuth ?? null;
}

function normalizeServerOrigin(rawValue: string): string {
  const raw = rawValue.trim();
  if (!raw) throw new Error("请输入 Companion Server 地址。");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("地址格式无效，请输入完整 URL。");
  }

  if (url.username || url.password) throw new Error("地址中不能包含用户名或密码。");
  if (url.search || url.hash) throw new Error("地址中不能包含查询参数或片段。");
  if (url.pathname !== "/") throw new Error("请输入服务器 origin，不要附加路径。");

  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowedProtocol = url.protocol === "https:" || (allowHttpLocalhost && localhost && url.protocol === "http:");
  if (!allowedProtocol) throw new Error("仅允许 HTTPS；开发构建可显式启用 localhost HTTP。");
  if (url.protocol === "https:" && url.port && url.port !== "443") {
    throw new Error("移动应用仅允许标准 HTTPS 443 端口。");
  }
  if (!trustedOrigins.has(url.origin)) throw new Error("此服务器未列入当前应用构建的受信地址。");
  return url.origin;
}

async function saveOrigin(origin: string): Promise<void> {
  const preferences = window.Capacitor?.Plugins?.Preferences;
  if (preferences) {
    await preferences.set({ key: originStorageKey, value: origin });
    return;
  }
  localStorage.setItem(originStorageKey, origin);
}

async function loadOrigin(): Promise<string | null> {
  const preferences = window.Capacitor?.Plugins?.Preferences;
  if (preferences) return (await preferences.get({ key: originStorageKey })).value;
  return localStorage.getItem(originStorageKey);
}

function setState(state: "idle" | "checking" | "pairing" | "connected" | "error", text: string, detail: string): void {
  panel.dataset.state = state;
  statusLabel.textContent = text;
  message.textContent = detail;
  message.className = `message ${state === "error" ? "error" : state === "connected" ? "success" : ""}`;
  input.setAttribute("aria-invalid", String(state === "error"));
}

async function apiRequest<T>(origin: string, path: string, body: object): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) throw new ApiFailure(401, "配对码无效、已过期或刷新凭据已撤销。");
      if (response.status === 423) throw new ApiFailure(423, "服务器 Vault 已锁定，请先在电脑端解锁。");
      throw new ApiFailure(response.status, `服务器返回 HTTP ${response.status}。`);
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("连接超时，请确认服务器在线后重试。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function verifyHealth(origin: string): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${origin}/healthz`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error(`健康检查返回 HTTP ${response.status}。`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("连接超时，请确认服务器在线后重试。");
    if (error instanceof Error) throw error;
    throw new Error("无法连接服务器，请检查网络和证书。");
  } finally {
    window.clearTimeout(timeout);
  }
}

function validateAuthResponse(value: AuthResponse): AuthResponse {
  if (!value || typeof value.refresh_token !== "string" || value.refresh_token.length < 32) throw new Error("服务器未返回有效刷新凭据。");
  if (typeof value.access_token !== "string" || value.access_token.length < 20) throw new Error("服务器未返回有效访问凭据。");
  if (!Number.isFinite(Date.parse(value.access_token_expires_at))) throw new Error("访问凭据过期时间无效。");
  return value;
}

async function persistAndEnter(origin: string, response: AuthResponse): Promise<void> {
  const plugin = authPlugin();
  if (!plugin) throw new Error("安全凭据存储仅在 iOS/Android 应用中可用。");
  const auth = validateAuthResponse(response);
  await plugin.persistAuth({
    refreshToken: auth.refresh_token,
    accessToken: auth.access_token,
    accessTokenExpiresAt: auth.access_token_expires_at,
    accessTokenExpiresAtEpochMs: Date.parse(auth.access_token_expires_at),
    serverOrigin: origin,
    ...(auth.rotation_id ? { rotationId: auth.rotation_id } : {}),
  });
  auth.refresh_token = "";
  auth.access_token = "";
  await saveOrigin(origin);
  setState("connected", "已安全连接", "凭据已保存到系统安全存储，正在进入 Companion Space…");
  window.location.assign(origin);
}

async function tryRefresh(origin: string): Promise<boolean> {
  const plugin = authPlugin();
  if (!plugin) return false;
  const stored = await plugin.getRefreshToken();
  if (!stored.value) return false;
  try {
    const auth = await apiRequest<AuthResponse>(origin, "/api/v1/mobile/auth/refresh", { refresh_token: stored.value });
    stored.value = null;
    await persistAndEnter(origin, auth);
    return true;
  } catch (error) {
    stored.value = null;
    if (error instanceof ApiFailure && error.status === 401) {
      await plugin.clearAuth();
      return false;
    }
    throw error;
  }
}

function showPairing(): void {
  pairingFields.hidden = false;
  codeInput.required = true;
  deviceInput.required = true;
  setState("pairing", "等待配对", "在电脑端生成一次性 8 位配对码，然后在上方输入。");
  codeInput.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  try {
    const origin = normalizeServerOrigin(input.value);
    setState("checking", "正在验证", "正在检查受信地址与服务器健康状态…");
    await verifyHealth(origin);

    if (pairingFields.hidden) {
      if (await tryRefresh(origin)) return;
      showPairing();
      return;
    }

    const code = codeInput.value.replace(/\s/g, "");
    const deviceName = deviceInput.value.trim();
    if (!/^\d{8}$/.test(code)) throw new Error("配对码必须是 8 位数字。");
    if (!deviceName || deviceName.length > 80) throw new Error("设备名称长度应为 1–80 个字符。");
    setState("checking", "正在配对", "正在交换一次性配对码并写入系统安全存储…");
    const auth = await apiRequest<AuthResponse>(origin, "/api/v1/mobile/pairing/exchange", {
      code,
      device_name: deviceName,
    });
    codeInput.value = "";
    await persistAndEnter(origin, auth);
  } catch (error) {
    codeInput.value = "";
    setState("error", "连接失败", error instanceof Error ? error.message : "连接失败，请重试。");
  } finally {
    button.disabled = false;
  }
});

trustedList.textContent = [...trustedOrigins].join("、") || "此构建未配置受信地址";
deviceInput.value = navigator.platform ? `我的 ${navigator.platform}`.slice(0, 80) : "我的移动设备";
void loadOrigin().then(async (origin) => {
  if (!origin || !trustedOrigins.has(origin)) return;
  input.value = origin;
  if (!authPlugin()) return;
  button.disabled = true;
  try {
    setState("checking", "正在恢复会话", "正在检查服务器并轮换移动端凭据…");
    await verifyHealth(origin);
    if (!(await tryRefresh(origin))) showPairing();
  } catch (error) {
    setState("error", "恢复失败", error instanceof Error ? error.message : "无法恢复移动会话。");
  } finally {
    button.disabled = false;
  }
});

export { normalizeServerOrigin };
