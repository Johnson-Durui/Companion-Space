import { createApiClient } from "@companion-space/api-client";
import type { paths } from "@companion-space/api-client/schema";
import t from "../locales/zh-CN.json";

export const api = createApiClient(window.location.origin);
export const sessionKey = ["session"] as const;
export const settingsKey = ["settings"] as const;
export const charactersKey = ["characters"] as const;
export const rolesKey = ["model-roles"] as const;
export const connectionsKey = ["connections"] as const;
export const avatarDriversKey = ["avatar-drivers"] as const;

export class ApiError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500;
}

export function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof ApiError && error.code) return error.code;
  if (error && typeof error === "object") {
    if ("code" in error && typeof error.code === "string") return error.code;
    if (
      "detail" in error &&
      error.detail &&
      typeof error.detail === "object" &&
      "code" in error.detail &&
      typeof error.detail.code === "string"
    ) {
      return error.detail.code;
    }
  }
  return undefined;
}

export function publicMessage(error: unknown) {
  const code = errorCodeOf(error);
  if (code && Object.hasOwn(t.errors, code)) {
    return t.errors[code as keyof typeof t.errors];
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") return error.detail;
  return undefined;
}

/** Map classroom HTTP / WS errors strictly through zh-CN error codes (never leaks raw English text). */
export function classroomErrorMessage(error: unknown, fallback: string = t.classroom.actionError): string {
  const code = errorCodeOf(error);
  if (code && Object.hasOwn(t.errors, code)) {
    return t.errors[code as keyof typeof t.errors];
  }
  return fallback;
}

export function ensureOK(response: Response, error: unknown) {
  if (!response.ok) throw new ApiError(publicMessage(error) ?? t.common.error, response.status, errorCodeOf(error));
}

export function bodyOf<T>(result: { data?: T; error?: unknown; response: Response }): T {
  ensureOK(result.response, result.error);
  if (result.data === undefined) throw new Error(t.common.error);
  return result.data;
}

export async function bootstrapSession() { return bodyOf(await api.POST("/api/v2/session/bootstrap")); }
export async function fetchSettings() { return bodyOf(await api.GET("/api/v2/settings")); }
export async function fetchCharacters() { return bodyOf(await api.GET("/api/v2/characters")); }
export async function fetchRoles() { return bodyOf(await api.GET("/api/v2/settings/model-roles")); }
export async function fetchConnections() { return bodyOf(await api.GET("/api/v2/providers/connections")); }
export async function fetchAvatarDriverSettings() { return bodyOf(await api.GET("/api/v2/avatar-drivers/settings")); }

export type SessionStatus = Awaited<ReturnType<typeof bootstrapSession>>;
export type Character = Awaited<ReturnType<typeof fetchCharacters>>[number];
export type Connection = Awaited<ReturnType<typeof fetchConnections>>[number];
export type ModelRoles = Awaited<ReturnType<typeof fetchRoles>>;
export type AvatarDriverSettings = Awaited<ReturnType<typeof fetchAvatarDriverSettings>>;
export type ChatInput = paths["/api/v2/diagnostics/chat"]["post"]["requestBody"]["content"]["application/json"];
