import type { NeuralTtsSidecarStatus, VaultStatus } from "@/lib/types";
import { apiClient, apiData, contractError, expectBoolean, expectNullableString, expectRecord, expectString, request } from "./transport";
import { clearOwnerSessionToken, markOwnerSessionAuthenticated } from "@/lib/owner-session";

function asVaultStatus(payload: unknown): VaultStatus {
  const record = expectRecord(payload, "Vault 状态接口");
  if (typeof record.initialized !== "boolean" || typeof record.unlocked !== "boolean") {
    throw contractError("Vault 状态接口字段无效", payload);
  }
  return {
    initialized: record.initialized,
    unlocked: record.unlocked,
    owner_session_authenticated: record.owner_session_authenticated === true,
  };
}

export async function getVaultStatus() {
  const vault = asVaultStatus(apiData(await apiClient().GET("/api/v1/vault/status"), "读取保险箱状态失败"));
  if (vault.owner_session_authenticated) markOwnerSessionAuthenticated();
  return vault;
}

export async function getNeuralTtsSidecarStatus() {
  const payload = await request<unknown>("/api/v1/tts/sidecar", { auth: "none" });
  const record = expectRecord(payload, "神经语音 sidecar 状态接口");
  return {
    enabled: expectBoolean(record.enabled, "神经语音 sidecar.enabled"),
    ready: expectBoolean(record.ready, "神经语音 sidecar.ready"),
    connection_id: expectString(record.connection_id, "神经语音 sidecar.connection_id"),
    model: expectNullableString(record.model, "神经语音 sidecar.model"),
    new_spaces_use_neural: expectBoolean(
      record.new_spaces_use_neural,
      "神经语音 sidecar.new_spaces_use_neural",
    ),
    how_to_switch: expectString(record.how_to_switch, "神经语音 sidecar.how_to_switch"),
  } satisfies NeuralTtsSidecarStatus;
}

export async function initializeVault(input: { password: string }) {
  const payload = apiData(await apiClient().POST("/api/v1/vault/init", { headers: { "X-Companion-Browser": "1" }, body: input }), "无法授权浏览器");
  markOwnerSessionAuthenticated();
  return payload;
}

export async function unlockVault(input: { password: string }) {
  const payload = apiData(await apiClient().POST("/api/v1/vault/unlock", { headers: { "X-Companion-Browser": "1" }, body: input }), "无法授权浏览器");
  markOwnerSessionAuthenticated();
  return payload;
}

export async function lockVault() {
  const status = await request<VaultStatus>("/api/v1/vault/lock", { method: "POST" });
  clearOwnerSessionToken({ notifyOtherTabs: true });
  return status;
}

export async function resetVault(input: { password: string }) {
  const status = await request<VaultStatus>("/api/v1/vault/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  clearOwnerSessionToken({ notifyOtherTabs: true });
  return status;
}
