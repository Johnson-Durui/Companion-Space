import type { ProviderCapability, ProviderConnection, ProviderConnectionWire, ProviderModelsResponseWire, ProviderRegistryEntryWire, ProviderTestResponseWire } from "@/lib/types";
import { contractError, expectArray, expectBoolean, expectCapabilityArray, expectNullableNumber, expectNullableString, expectRecord, expectString, expectStringArray, request, requestBinary } from "./transport";

export interface ProviderConnectionCreateInput {
  label: string;
  provider: string;
  api_key: string;
  base_url?: string | null;
}

export interface ProviderConnectionUpdateInput {
  label?: string;
  api_key?: string;
  base_url?: string | null;
}

interface LegacyProviderConnectionCreateInput extends ProviderConnectionCreateInput {
  default_model?: string;
  capabilities?: string[];
}

function asProviderConnectionWire(payload: unknown, context: string): ProviderConnectionWire {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    provider: expectString(record.provider, `${context}.provider`),
    label: expectString(record.label, `${context}.label`),
    base_url: expectNullableString(record.base_url, `${context}.base_url`),
    capabilities: expectCapabilityArray(record.capabilities, `${context}.capabilities`),
    created_at: expectString(record.created_at, `${context}.created_at`),
    updated_at: expectString(record.updated_at, `${context}.updated_at`),
  };
}

function asProviderRegistryEntry(payload: unknown, context: string): ProviderRegistryEntryWire {
  const record = expectRecord(payload, context);
  return {
    provider: expectString(record.provider, `${context}.provider`),
    capabilities: expectCapabilityArray(record.capabilities, `${context}.capabilities`),
    supports_custom_base_url: expectBoolean(
      record.supports_custom_base_url,
      `${context}.supports_custom_base_url`,
    ),
    requires_api_key: expectBoolean(
      record.requires_api_key,
      `${context}.requires_api_key`,
    ),
    default_models: expectStringArray(record.default_models, `${context}.default_models`),
  };
}

function asProviderModelsResponse(payload: unknown, context: string): ProviderModelsResponseWire {
  const record = expectRecord(payload, context);
  return {
    models: expectStringArray(record.models, `${context}.models`),
  };
}

function asProviderTestResponse(payload: unknown, context: string): ProviderTestResponseWire {
  const record = expectRecord(payload, context);
  const mode = expectString(record.mode, `${context}.mode`);
  if (mode !== "local" && mode !== "remote") {
    throw contractError(`${context}.mode 返回了未知值`, record.mode);
  }
  return {
    connection_id: expectString(record.connection_id, `${context}.connection_id`),
    provider: expectString(record.provider, `${context}.provider`),
    ok: expectBoolean(record.ok, `${context}.ok`),
    mode,
    capabilities: expectCapabilityArray(record.capabilities, `${context}.capabilities`),
    models: expectStringArray(record.models, `${context}.models`),
    latency_ms: expectNullableNumber(record.latency_ms, `${context}.latency_ms`),
    message: expectNullableString(record.message, `${context}.message`),
  };
}

function toProviderView(provider: ProviderConnectionWire): ProviderConnection {
  return {
    id: provider.id,
    provider: provider.provider,
    label: provider.label,
    base_url: provider.base_url,
    capabilities: provider.capabilities,
    created_at: provider.created_at,
    updated_at: provider.updated_at,
  };
}

export async function listProviders() {
  const payload = await request<unknown>("/api/v1/providers/connections");
  return expectArray<unknown>(payload, "Provider 列表接口").map((item, index) =>
    toProviderView(asProviderConnectionWire(item, `Provider 列表接口[${index}]`))
  );
}

export async function listProviderRegistry() {
  const payload = await request<unknown>("/api/v1/providers/registry");
  return expectArray<unknown>(payload, "Provider Registry 接口").map((item, index) =>
    asProviderRegistryEntry(item, `Provider Registry 接口[${index}]`)
  );
}

export async function createProvider(input: LegacyProviderConnectionCreateInput) {
  const payload = await request<unknown>("/api/v1/providers/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: input.label,
      provider: input.provider,
      api_key: input.api_key,
      base_url: input.base_url,
    } satisfies ProviderConnectionCreateInput),
  });
  return toProviderView(asProviderConnectionWire(payload, "创建 Provider 接口"));
}

export async function updateProvider(
  providerId: string,
  input: ProviderConnectionUpdateInput & {
    default_model?: string;
    capabilities?: string[];
  },
) {
  const payload = await request<unknown>(
    `/api/v1/providers/connections/${providerId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: input.label,
        api_key: input.api_key,
        base_url: input.base_url,
      }),
    },
  );
  return toProviderView(asProviderConnectionWire(payload, "更新 Provider 接口"));
}

export async function testProvider(providerId: string) {
  const payload = await request<unknown>(
    `/api/v1/providers/connections/${providerId}/test`,
    { method: "POST" },
  );
  return asProviderTestResponse(payload, "Provider 测试接口");
}

export async function discoverProviderModels(
  providerId: string,
  capability?: ProviderCapability,
) {
  const search = capability
    ? `?capability=${encodeURIComponent(capability)}`
    : "";
  const payload = await request<unknown>(
    `/api/v1/providers/connections/${providerId}/models${search}`,
  );
  return asProviderModelsResponse(payload, "Provider 模型发现接口");
}

export async function deleteProvider(providerId: string) {
  return request<null>(`/api/v1/providers/connections/${providerId}`, {
    method: "DELETE",
  });
}

export async function previewProviderSpeech(input: {
  connectionId: string;
  model: string;
  text: string;
  voiceId: string;
  speakingRate: number;
  signal?: AbortSignal;
}) {
  const response = await requestBinary(
    `/api/v1/providers/connections/${encodeURIComponent(input.connectionId)}/speech-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        text: input.text,
        voice_id: input.voiceId,
        speaking_rate: input.speakingRate,
      }),
      signal: input.signal,
    },
    "语音合成测试失败",
  );
  const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
  if (sampleRate !== 24000 || response.headers.get("x-audio-channels") !== "1") {
    throw new Error("语音接口未返回受支持的 24000 Hz 单声道音频。");
  }
  const pcm16 = await response.arrayBuffer();
  if (!pcm16.byteLength || pcm16.byteLength % 2 !== 0) {
    throw new Error("语音接口未返回有效的 PCM16 音频。");
  }
  return { pcm16, sampleRate };
}
