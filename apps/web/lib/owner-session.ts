import { Capacitor, registerPlugin } from "@capacitor/core";

let ownerToken: string | null = null;
let ownerTokenExpiresAtEpochMs = 0;
let ownerSessionChannel: BroadcastChannel | null = null;
let nativeSessionPromise: Promise<string | null> | null = null;
let nativeSessionGeneration = 0;
let nativeLifecycleListenerAttached = false;
const listeners = new Set<(token: string | null) => void>();

const OWNER_SESSION_CHANNEL = "companion-space-owner-session";

function isBrowserRuntime() {
  return typeof window !== "undefined";
}

type NativeAuthPlugin = {
  getAccessToken(): Promise<{ value?: string | null; expiresAt?: string | null }>;
  refreshAccessToken(): Promise<{ value?: string | null; expiresAt?: string | null }>;
  clearAccessToken(): Promise<void>;
  clearAuth(): Promise<void>;
  returnToLauncher(): Promise<void>;
};

const companionAuthPlugin = registerPlugin<NativeAuthPlugin>("CompanionAuth");

const NATIVE_REFRESH_SKEW_MS = 30_000;

function getNativeAuthPlugin(): NativeAuthPlugin | null {
  if (!isBrowserRuntime()) return null;
  if (!Capacitor.isNativePlatform()) return null;
  return companionAuthPlugin;
}

export function isNativeOwnerSessionRuntime(): boolean {
  return getNativeAuthPlugin() !== null;
}

function acceptNativeAccessToken(result: { value?: string | null; expiresAt?: string | null }): string {
  const expiresAtEpochMs = typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : Number.NaN;
  if (typeof result.value !== "string" || !result.value.trim() || !Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) {
    throw new Error("Native owner session is missing or expired");
  }
  ownerToken = result.value.trim();
  ownerTokenExpiresAtEpochMs = expiresAtEpochMs;
  notifyListeners();
  return ownerToken;
}

function clearLocalOwnerSession(): void {
  ownerToken = null;
  ownerTokenExpiresAtEpochMs = 0;
  notifyListeners();
}

function nativeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

async function loadOrRefreshNativeAccess(
  plugin: NativeAuthPlugin,
  generation: number,
): Promise<string | null> {
  try {
    if (ownerToken && ownerTokenExpiresAtEpochMs > Date.now() + NATIVE_REFRESH_SKEW_MS) return ownerToken;
    if (!ownerToken) {
      const storedAccess = await plugin.getAccessToken();
      if (generation !== nativeSessionGeneration) return null;
      if (typeof storedAccess.value === "string" && storedAccess.value.trim()) {
        acceptNativeAccessToken(storedAccess);
        if (ownerTokenExpiresAtEpochMs > Date.now() + NATIVE_REFRESH_SKEW_MS) return ownerToken;
      }
    }
    const refreshedAccess = await plugin.refreshAccessToken();
    if (generation !== nativeSessionGeneration) return null;
    return acceptNativeAccessToken(refreshedAccess);
  } catch (error) {
    if (generation !== nativeSessionGeneration) return null;
    clearLocalOwnerSession();
    if (nativeErrorCode(error) === "AUTH_REVOKED") {
      await plugin.returnToLauncher().catch(() => undefined);
    }
    return null;
  }
}

function setupNativeLifecycleRefresh(): void {
  if (nativeLifecycleListenerAttached || typeof document === "undefined") return;
  nativeLifecycleListenerAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ensureNativeOwnerSessionToken();
  });
  window.addEventListener("pageshow", () => void ensureNativeOwnerSessionToken());
}

export async function ensureNativeOwnerSessionToken(): Promise<string | null> {
  const plugin = getNativeAuthPlugin();
  if (!plugin) return ownerToken;
  setupNativeLifecycleRefresh();
  if (ownerToken && ownerTokenExpiresAtEpochMs > Date.now() + NATIVE_REFRESH_SKEW_MS) return ownerToken;
  if (!nativeSessionPromise) {
    const pending = loadOrRefreshNativeAccess(plugin, nativeSessionGeneration).finally(() => {
      if (nativeSessionPromise === pending) nativeSessionPromise = null;
    });
    nativeSessionPromise = pending;
  }
  return nativeSessionPromise;
}

export function getOwnerSessionToken(): string | null {
  if (!isBrowserRuntime()) return null;
  if (isNativeOwnerSessionRuntime() && ownerTokenExpiresAtEpochMs <= Date.now()) return null;
  return ownerToken;
}

function notifyListeners() {
  for (const listener of listeners) {
    listener(ownerToken);
  }
}

function getOwnerSessionChannel(): BroadcastChannel | null {
  if (!isBrowserRuntime() || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (!ownerSessionChannel) {
    ownerSessionChannel = new BroadcastChannel(OWNER_SESSION_CHANNEL);
    ownerSessionChannel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "owner-session-cleared"
      ) {
        nativeSessionGeneration += 1;
        clearLocalOwnerSession();
      }
    });
  }
  return ownerSessionChannel;
}

export function setOwnerSessionToken(token: string): void {
  if (!isBrowserRuntime()) {
    return;
  }
  if (isNativeOwnerSessionRuntime()) {
    void ensureNativeOwnerSessionToken();
    return;
  }
  const nextToken = token.trim();
  ownerToken = nextToken || null;
  ownerTokenExpiresAtEpochMs = ownerToken ? Number.MAX_SAFE_INTEGER : 0;
  getOwnerSessionChannel();
  notifyListeners();
}

export function clearOwnerSessionToken(
  options: { notifyOtherTabs?: boolean } = {},
): void {
  ownerToken = null;
  ownerTokenExpiresAtEpochMs = 0;
  nativeSessionGeneration += 1;
  notifyListeners();
  void getNativeAuthPlugin()?.returnToLauncher().catch(() => undefined);
  if (options.notifyOtherTabs) {
    getOwnerSessionChannel()?.postMessage({ type: "owner-session-cleared" });
  }
}

export function subscribeOwnerSession(
  listener: (token: string | null) => void,
): () => void {
  listeners.add(listener);
  getOwnerSessionChannel();
  return () => {
    listeners.delete(listener);
  };
}
