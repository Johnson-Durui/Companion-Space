import { getApiBaseUrl } from "@/lib/runtime-config";
import type { ProviderCapability } from "@/lib/types";
import { browserApiFetch, createApiClient } from "@companion-space/api-client";
import { clearOwnerSessionToken } from "@/lib/owner-session";

const OWNER_AUTH_FAILURES = new Set([
  "Owner session required",
  "Invalid owner session",
  "Vault is locked",
]);

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  method?: HttpMethod;
  body?: BodyInit | null;
  headers?: HeadersInit;
  cache?: RequestCache;
  auth?: "none" | "owner";
  signal?: AbortSignal;
}

export function scopedItemKey(spaceId: string, itemId: string) {
  return `${spaceId}:${itemId}`;
}

export function apiUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function contractError(message: string, details: unknown): ApiError {
  return new ApiError(message, 502, details);
}

export function expectRecord(payload: unknown, context: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw contractError(`${context} 返回了无效对象`, payload);
  }
  return payload;
}

export function expectArray<T>(payload: unknown, context: string): T[] {
  if (!Array.isArray(payload)) {
    throw contractError(`${context} 返回了无效列表`, payload);
  }
  return payload as T[];
}

export function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

export function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

export function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

function expectDateTimeString(value: unknown, context: string): string {
  const dateTime = expectString(value, context);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw contractError(`${context} 返回了无效时间`, value);
  }
  return dateTime;
}

export function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, context);
}

export function expectNullableNumber(value: unknown, context: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

export function expectStringArray(payload: unknown, context: string): string[] {
  return expectArray<unknown>(payload, context).map((item, index) =>
    expectString(item, `${context}[${index}]`)
  );
}

const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  "chat_llm",
  "analysis_llm",
  "embedding",
  "stt",
  "tts",
];

export function asProviderCapability(value: unknown, context: string): ProviderCapability {
  const capability = expectString(value, context);
  if (!PROVIDER_CAPABILITIES.includes(capability as ProviderCapability)) {
    throw contractError(`${context} 返回了未知能力位`, value);
  }
  return capability as ProviderCapability;
}

export function expectCapabilityArray(payload: unknown, context: string): ProviderCapability[] {
  return expectArray<unknown>(payload, context).map((item, index) =>
    asProviderCapability(item, `${context}[${index}]`)
  );
}

export function expectArrayField<T>(payload: unknown, key: string, context: string): T[] {
  const record = expectRecord(payload, context);
  if (!Array.isArray(record[key])) {
    throw contractError(`${context} 缺少 ${key} 列表`, payload);
  }
  return record[key] as T[];
}

function expectObjectField<T>(payload: unknown, key: string, context: string): T {
  const record = expectRecord(payload, context);
  if (!isRecord(record[key])) {
    throw contractError(`${context} 缺少 ${key} 对象`, payload);
  }
  return record[key] as T;
}

export async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  return text ? { detail: text } : null;
}

export function errorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }
  if (typeof payload.detail === "string") {
    return payload.detail;
  }
  return fallback;
}

export function isOwnerAuthFailure(status: number, payload: unknown): boolean {
  return (
    status === 401 &&
    isRecord(payload) &&
    typeof payload.detail === "string" &&
    OWNER_AUTH_FAILURES.has(payload.detail)
  );
}

export class ApiError extends Error {
  status: number;

  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);

  const method = options.method ?? "GET";
  const response = await browserApiFetch(apiUrl(path), {
    method,
    body: options.body,
    headers,
    cache: options.cache ?? "no-store",
    signal: options.signal,
  });
  const parsed = await parseResponse(response);

  if (!response.ok) {
    if (isOwnerAuthFailure(response.status, parsed)) {
      clearOwnerSessionToken({
        notifyOtherTabs:
          isRecord(parsed) && parsed.detail === "Vault is locked",
      });
    }
    throw new ApiError(errorMessage(parsed, `${method} ${path} failed`), response.status, parsed);
  }

  return parsed as T;
}

export async function requestBinary(
  path: string,
  options: RequestOptions,
  fallbackMessage: string,
): Promise<Response> {
  const headers = new Headers(options.headers);
  const method = options.method ?? "GET";
  const response = await browserApiFetch(apiUrl(path), {
    method,
    body: options.body,
    headers,
    cache: options.cache ?? "no-store",
    signal: options.signal,
  });
  if (response.ok) {
    return response;
  }
  const parsed = await parseResponse(response);
  if (isOwnerAuthFailure(response.status, parsed)) {
    clearOwnerSessionToken({
      notifyOtherTabs:
        isRecord(parsed) && parsed.detail === "Vault is locked",
    });
  }
  throw new ApiError(
    errorMessage(parsed, fallbackMessage),
    response.status,
    parsed,
  );
}

export function apiClient() {
  return createApiClient(getApiBaseUrl());
}

export function apiData<T>(
  { data, error, response }: { data?: T; error?: unknown; response: Response },
  context: string,
): T {
  if (!response.ok) {
    if (isOwnerAuthFailure(response.status, error)) {
      clearOwnerSessionToken({ notifyOtherTabs: isRecord(error) && error.detail === "Vault is locked" });
    }
    throw new ApiError(errorMessage(error, context), response.status, error);
  }
  if (data === undefined && response.status !== 204) throw contractError(context, null);
  return data as T;
}
