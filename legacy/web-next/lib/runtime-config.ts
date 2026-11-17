const LOCAL_API_FALLBACK = "http://localhost:8000";
const SESSION_ID_PLACEHOLDER = ":sessionId";

export interface CompanionRuntimeConfig {
  apiBaseUrl?: string;
  realtimeWsUrlTemplate?: string | null;
}

interface RuntimeConfigEnvironment {
  apiBaseUrl?: string;
  realtimeWsUrlTemplate?: string;
}

interface RuntimeConfigContext {
  environment?: RuntimeConfigEnvironment;
  pageUrl?: string;
  runtimeConfig?: unknown;
}

export interface ResolvedRuntimeConfig {
  apiBaseUrl: string;
  realtimeWsUrlTemplate: string | null;
}

declare global {
  interface Window {
    __COMPANION_SPACE_RUNTIME_CONFIG__?: CompanionRuntimeConfig;
  }
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInjectedConfig(value: unknown): CompanionRuntimeConfig {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new RuntimeConfigError("运行时配置必须是对象。");
  }
  const unknownKey = Object.keys(value).find(
    (key) => key !== "apiBaseUrl" && key !== "realtimeWsUrlTemplate",
  );
  if (unknownKey) {
    throw new RuntimeConfigError(`运行时配置包含未知字段：${unknownKey}。`);
  }
  const hasApiBaseUrl = Object.hasOwn(value, "apiBaseUrl");
  const hasRealtimeWsUrlTemplate = Object.hasOwn(value, "realtimeWsUrlTemplate");
  const apiBaseUrl = hasApiBaseUrl ? value.apiBaseUrl : undefined;
  const realtimeWsUrlTemplate = hasRealtimeWsUrlTemplate
    ? value.realtimeWsUrlTemplate
    : undefined;
  if (apiBaseUrl !== undefined && typeof apiBaseUrl !== "string") {
    throw new RuntimeConfigError("运行时配置 apiBaseUrl 必须是字符串。");
  }
  if (
    realtimeWsUrlTemplate !== undefined &&
    realtimeWsUrlTemplate !== null &&
    typeof realtimeWsUrlTemplate !== "string"
  ) {
    throw new RuntimeConfigError("运行时配置 realtimeWsUrlTemplate 必须是字符串或 null。");
  }
  return {
    ...(hasApiBaseUrl ? { apiBaseUrl: apiBaseUrl as string } : {}),
    ...(hasRealtimeWsUrlTemplate
      ? { realtimeWsUrlTemplate: realtimeWsUrlTemplate as string | null }
      : {}),
  };
}

function parseUrl(value: string, label: string, pageUrl?: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RuntimeConfigError(`${label} 不得为空。`);
  }
  try {
    if (pageUrl) {
      return new URL(trimmed, pageUrl);
    }
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      return new URL(trimmed, `${LOCAL_API_FALLBACK}/`);
    }
    return new URL(trimmed);
  } catch {
    throw new RuntimeConfigError(`${label} 不是有效 URL。`);
  }
}

function rejectUrlSecrets(url: URL, label: string) {
  if (url.username || url.password) {
    throw new RuntimeConfigError(`${label} 不得包含用户名或密码。`);
  }
  if (url.search || url.hash || url.href.includes("?") || url.href.includes("#")) {
    throw new RuntimeConfigError(`${label} 不得包含查询参数或片段。`);
  }
}

function isHttpsPage(pageUrl?: string) {
  return pageUrl ? new URL(pageUrl).protocol === "https:" : false;
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function resolveApiBaseUrl(value: string, pageUrl?: string) {
  const url = parseUrl(value, "API 地址", pageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConfigError("API 地址必须使用 http:// 或 https://。");
  }
  rejectUrlSecrets(url, "API 地址");
  if (isHttpsPage(pageUrl) && url.protocol !== "https:") {
    throw new RuntimeConfigError("HTTPS 页面只能连接加密的 https:// API 地址。");
  }
  return url.toString().replace(/\/$/, "");
}

function resolveRealtimeTemplate(
  value: string | null | undefined,
  apiBaseUrl: string,
  pageUrl?: string,
) {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  if (value.split(SESSION_ID_PLACEHOLDER).length !== 2) {
    throw new RuntimeConfigError("实时地址模板必须且只能包含一个 :sessionId 占位符。");
  }
  const templateUrl = parseUrl(
    value.replace(SESSION_ID_PLACEHOLDER, "00000000-0000-4000-8000-000000000000"),
    "实时地址模板",
    pageUrl,
  );
  if (/\:[A-Za-z][A-Za-z0-9_]*/.test(templateUrl.pathname)) {
    throw new RuntimeConfigError("实时地址模板只允许 :sessionId 占位符。");
  }
  if (templateUrl.protocol === "http:") {
    templateUrl.protocol = "ws:";
  } else if (templateUrl.protocol === "https:") {
    templateUrl.protocol = "wss:";
  }
  if (templateUrl.protocol !== "ws:" && templateUrl.protocol !== "wss:") {
    throw new RuntimeConfigError("实时地址模板必须使用 ws:// 或 wss://。");
  }
  rejectUrlSecrets(templateUrl, "实时地址模板");
  if (isHttpsPage(pageUrl) && templateUrl.protocol !== "wss:") {
    throw new RuntimeConfigError("HTTPS 页面只能连接加密的 wss:// 实时地址。");
  }
  if (
    pageUrl &&
    new URL(pageUrl).protocol === "http:" &&
    templateUrl.protocol === "ws:" &&
    !isLoopbackHostname(templateUrl.hostname)
  ) {
    throw new RuntimeConfigError("未加密的 ws:// 仅允许本机开发地址。");
  }

  const trustedHosts = new Set([new URL(apiBaseUrl).host]);
  if (pageUrl) {
    trustedHosts.add(new URL(pageUrl).host);
  }
  if (!trustedHosts.has(templateUrl.host)) {
    throw new RuntimeConfigError("实时地址不属于当前页面或 API 服务，已拒绝发送鉴权票据。");
  }
  return templateUrl
    .toString()
    .replace("00000000-0000-4000-8000-000000000000", SESSION_ID_PLACEHOLDER);
}

export function resolveRuntimeConfig(context: RuntimeConfigContext = {}): ResolvedRuntimeConfig {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const injected = readInjectedConfig(
    context.runtimeConfig ?? browserWindow?.__COMPANION_SPACE_RUNTIME_CONFIG__,
  );
  const environment = context.environment ?? {
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    realtimeWsUrlTemplate: process.env.NEXT_PUBLIC_REALTIME_WS_URL,
  };
  const pageUrl = context.pageUrl ?? browserWindow?.location.href;
  const apiBaseUrl = resolveApiBaseUrl(
    injected.apiBaseUrl ?? environment.apiBaseUrl ?? LOCAL_API_FALLBACK,
    pageUrl,
  );
  const realtimeWsUrlTemplate = resolveRealtimeTemplate(
    Object.hasOwn(injected, "realtimeWsUrlTemplate")
      ? injected.realtimeWsUrlTemplate
      : environment.realtimeWsUrlTemplate,
    apiBaseUrl,
    pageUrl,
  );
  return { apiBaseUrl, realtimeWsUrlTemplate };
}

export function getApiBaseUrl() {
  return resolveRuntimeConfig().apiBaseUrl;
}

export function resolveRealtimeWsUrl(sessionId: string) {
  const { realtimeWsUrlTemplate } = resolveRuntimeConfig();
  return realtimeWsUrlTemplate?.replace(
    SESSION_ID_PLACEHOLDER,
    encodeURIComponent(sessionId),
  ) ?? null;
}
