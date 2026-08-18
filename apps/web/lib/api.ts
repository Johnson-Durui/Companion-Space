import type {
  AvatarFraming,
  AvatarStageBackground,
  BoardUpdatePayload,
  CharacterPackDetail,
  CharacterPackSummary,
  CharacterPackWire,
  CharacterPreviewState,
  CharacterRecipe,
  CharacterWorkshopDocument,
  CompanionTurn,
  DemoReadyPayload,
  DashboardSnapshot,
  IngestionJob,
  LegacyKnowledgeCandidate,
  LegacyKnowledgeImportResult,
  LessonScript,
  LocalMetricSignalInput,
  LocalMetricsSummary,
  MaterialIngestionResponseWire,
  MaterialKind,
  MaterialRecord,
  MemoryItem,
  MemoryItemWire,
  MobileDevice,
  MobilePairingChallenge,
  ModelAssignment,
  ModelAssignmentWire,
  OwnerPreferences,
  OwnerPreferencesWire,
  ProviderConnection,
  ProviderConnectionWire,
  ProviderModelsResponseWire,
  ProviderRegistryEntryWire,
  ProviderTestResponseWire,
  ProviderCapability,
  RealtimeEventWire,
  RealtimeTicketResponseWire,
  ReviewItem,
  ReviewItemWire,
  ReviewStatus,
  SessionDemoRequestInput,
  SessionDemoResponseWire,
  SessionDetail,
  SessionRecordWire,
  SessionSummary,
  SessionTranscriptResponseWire,
  SpaceDetailResponseWire,
  StudySpaceDetail,
  StudySpaceSummary,
  StudySpaceWire,
  TtsPlaybackPolicy,
  NeuralTtsSidecarStatus,
  VaultStatus,
  VaultUnlockResponse,
} from "@/lib/types";
import { decodeSessionDemoResponse } from "@/components/lesson/lesson-contract";
import {
  clearOwnerSessionToken,
  ensureNativeOwnerSessionToken,
  getOwnerSessionToken,
  isNativeOwnerSessionRuntime,
  setOwnerSessionToken,
} from "@/lib/owner-session";
import defaultCharacterRecipeSeed from "../../../libs/schemas/default_character_recipe.json";
import defaultNovaCharacterRecipeSeed from "../../../libs/schemas/default_nova_character_recipe.json";
import { getApiBaseUrl } from "@/lib/runtime-config";

const MAX_CHARACTER_PACK_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_CHARACTER_CARD_SIZE_BYTES = 1_000_000;
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

export interface StudySpaceCreateInput {
  name: string;
  topic?: string;
  goal?: string;
}

interface LegacyStudySpaceCreateInput {
  title: string;
  theme?: string;
  goal?: string;
}

export interface StudySpaceUpdateInput {
  name: string;
  topic?: string;
  goal?: string;
}

interface LegacyStudySpaceUpdateInput {
  title?: string;
  theme?: string;
  goal?: string;
}

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

export interface CharacterCreateInput {
  name: string;
  description?: string;
  recipe?: CharacterRecipe;
}

interface LegacyCharacterCreateInput {
  name: string;
  style?: string;
  archetype?: string;
}

type MemoryUpdateInput =
  | Partial<Pick<MemoryItemWire, "content" | "status" | "sensitive">>
  | Partial<MemoryItem>;

type ReviewUpdateInput =
  | Partial<Pick<ReviewItemWire, "prompt" | "answer" | "due_at" | "status">>
  | Partial<ReviewItem>;

const memoryItemsById = new Map<string, MemoryItemWire>();
const reviewItemsById = new Map<string, ReviewItemWire>();
function scopedItemKey(spaceId: string, itemId: string) {
  return `${spaceId}:${itemId}`;
}

function apiUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contractError(message: string, details: unknown): ApiError {
  return new ApiError(message, 502, details);
}

function expectRecord(payload: unknown, context: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw contractError(`${context} 返回了无效对象`, payload);
  }
  return payload;
}

function expectArray<T>(payload: unknown, context: string): T[] {
  if (!Array.isArray(payload)) {
    throw contractError(`${context} 返回了无效列表`, payload);
  }
  return payload as T[];
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

function expectMaterialKind(value: unknown, context: string): MaterialKind {
  const kind = expectString(value, context);
  if (kind !== "pdf" && kind !== "markdown" && kind !== "text" && kind !== "note") {
    throw contractError(`${context} 返回了不支持的资料类型`, value);
  }
  return kind;
}

function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

function expectNumber(value: unknown, context: string): number {
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

function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return expectString(value, context);
}

function expectNullableNumber(value: unknown, context: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw contractError(`${context} 字段无效`, value);
  }
  return value;
}

function expectStringArray(payload: unknown, context: string): string[] {
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

function asProviderCapability(value: unknown, context: string): ProviderCapability {
  const capability = expectString(value, context);
  if (!PROVIDER_CAPABILITIES.includes(capability as ProviderCapability)) {
    throw contractError(`${context} 返回了未知能力位`, value);
  }
  return capability as ProviderCapability;
}

function expectCapabilityArray(payload: unknown, context: string): ProviderCapability[] {
  return expectArray<unknown>(payload, context).map((item, index) =>
    asProviderCapability(item, `${context}[${index}]`)
  );
}

function expectArrayField<T>(payload: unknown, key: string, context: string): T[] {
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

async function parseResponse(response: Response): Promise<unknown> {
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

function errorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }
  if (typeof payload.detail === "string") {
    return payload.detail;
  }
  return fallback;
}

function isOwnerAuthFailure(status: number, payload: unknown): boolean {
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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if ((options.auth ?? "owner") === "owner") {
    const token = isNativeOwnerSessionRuntime()
      ? await ensureNativeOwnerSessionToken()
      : getOwnerSessionToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else if (isNativeOwnerSessionRuntime()) {
      throw new ApiError("Mobile owner session refresh required", 401, null);
    }
  }

  const method = options.method ?? "GET";
  const response = await fetch(apiUrl(path), {
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

async function requestBinary(
  path: string,
  options: RequestOptions,
  fallbackMessage: string,
): Promise<Response> {
  const headers = new Headers(options.headers);
  if ((options.auth ?? "owner") === "owner") {
    const token = isNativeOwnerSessionRuntime()
      ? await ensureNativeOwnerSessionToken()
      : getOwnerSessionToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else if (isNativeOwnerSessionRuntime()) {
      throw new ApiError("Mobile owner session refresh required", 401, null);
    }
  }
  const method = options.method ?? "GET";
  const response = await fetch(apiUrl(path), {
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

function asVaultStatus(payload: unknown): VaultStatus {
  const record = expectRecord(payload, "Vault 状态接口");
  if (typeof record.initialized !== "boolean" || typeof record.unlocked !== "boolean") {
    throw contractError("Vault 状态接口字段无效", payload);
  }
  return {
    initialized: record.initialized,
    unlocked: record.unlocked,
  };
}

function asOwnerPreferences(payload: unknown): OwnerPreferences {
  const record = expectRecord(payload, "Vault 偏好接口");
  return {
    adult_relationships_enabled: expectBoolean(
      record.adult_relationships_enabled,
      "Vault 偏好接口.adult_relationships_enabled",
    ),
    adult_age_confirmed_at: expectNullableString(
      record.adult_age_confirmed_at,
      "Vault 偏好接口.adult_age_confirmed_at",
    ),
  };
}

function asLocalMetricsSummary(payload: unknown): LocalMetricsSummary {
  const root = expectRecord(payload, "本地指标接口");
  const activation = expectRecord(root.activation, "本地指标接口.activation");
  const reliability = expectRecord(root.reliability, "本地指标接口.reliability");
  const quality = expectRecord(root.quality, "本地指标接口.quality");
  const citation = expectRecord(
    quality.citation_verified,
    "本地指标接口.quality.citation_verified",
  );
  const performance = expectRecord(root.performance, "本地指标接口.performance");
  const rates = expectRecord(root.rates, "本地指标接口.rates");
  const numericSummary = (value: unknown, context: string) => {
    const record = expectRecord(value, context);
    return {
      count: expectNumber(record.count, `${context}.count`),
      ...(Object.hasOwn(record, "max")
        ? { max: expectNullableNumber(record.max, `${context}.max`) }
        : {}),
      ...(Object.hasOwn(record, "min")
        ? { min: expectNullableNumber(record.min, `${context}.min`) }
        : {}),
      p50: expectNullableNumber(record.p50, `${context}.p50`),
    };
  };
  const residue = expectRecord(
    performance.audio_residue_scan,
    "本地指标接口.performance.audio_residue_scan",
  );
  return {
    activation: {
      vault_initialized: expectNumber(activation.vault_initialized, "activation.vault_initialized"),
      provider_connected_or_mock: expectNumber(
        activation.provider_connected_or_mock,
        "activation.provider_connected_or_mock",
      ),
      space_created: expectNumber(activation.space_created, "activation.space_created"),
      material_ready: expectNumber(activation.material_ready, "activation.material_ready"),
      character_saved: expectNumber(activation.character_saved, "activation.character_saved"),
      session_ended: expectNumber(activation.session_ended, "activation.session_ended"),
      recap_viewed: expectNumber(activation.recap_viewed, "activation.recap_viewed"),
    },
    reliability: {
      api_error: expectNumber(reliability.api_error, "reliability.api_error"),
      ws_error: expectNumber(reliability.ws_error, "reliability.ws_error"),
      ingestion_failed: expectNumber(reliability.ingestion_failed, "reliability.ingestion_failed"),
      model_timeout: expectNumber(reliability.model_timeout, "reliability.model_timeout"),
      text_fallback_used: expectNumber(
        reliability.text_fallback_used,
        "reliability.text_fallback_used",
      ),
      illegal_state_transition: expectNumber(
        reliability.illegal_state_transition,
        "reliability.illegal_state_transition",
      ),
    },
    quality: {
      citation_verified: {
        matched: expectNumber(citation.matched, "quality.citation_verified.matched"),
        total: expectNumber(citation.total, "quality.citation_verified.total"),
      },
      recap_edited: expectNumber(quality.recap_edited, "quality.recap_edited"),
      memory_candidate_confirmed: expectNumber(
        quality.memory_candidate_confirmed,
        "quality.memory_candidate_confirmed",
      ),
      memory_candidate_rejected: expectNumber(
        quality.memory_candidate_rejected,
        "quality.memory_candidate_rejected",
      ),
    },
    performance: {
      interrupt_latency_ms: numericSummary(
        performance.interrupt_latency_ms,
        "performance.interrupt_latency_ms",
      ),
      first_audio_latency_ms: numericSummary(
        performance.first_audio_latency_ms,
        "performance.first_audio_latency_ms",
      ),
      avatar_fps: numericSummary(performance.avatar_fps, "performance.avatar_fps"),
      soak_memory_delta_mb: numericSummary(
        performance.soak_memory_delta_mb,
        "performance.soak_memory_delta_mb",
      ),
      audio_residue_scan: {
        clean: expectNumber(residue.clean, "performance.audio_residue_scan.clean"),
        residue_found: expectNumber(
          residue.residue_found,
          "performance.audio_residue_scan.residue_found",
        ),
      },
    },
    rates: {
      api_error_rate: expectNullableNumber(rates.api_error_rate, "rates.api_error_rate"),
      ws_error_rate: expectNullableNumber(rates.ws_error_rate, "rates.ws_error_rate"),
      ingestion_failure_rate: expectNullableNumber(
        rates.ingestion_failure_rate,
        "rates.ingestion_failure_rate",
      ),
      model_timeout_rate: expectNullableNumber(
        rates.model_timeout_rate,
        "rates.model_timeout_rate",
      ),
      text_fallback_rate: expectNullableNumber(
        rates.text_fallback_rate,
        "rates.text_fallback_rate",
      ),
      citation_accuracy: expectNullableNumber(rates.citation_accuracy, "rates.citation_accuracy"),
      recap_edit_rate: expectNullableNumber(rates.recap_edit_rate, "rates.recap_edit_rate"),
      memory_confirmation_rate: expectNullableNumber(
        rates.memory_confirmation_rate,
        "rates.memory_confirmation_rate",
      ),
    },
  };
}

function storeOwnerSession(payload: VaultUnlockResponse): VaultUnlockResponse {
  if (!payload.owner_token) {
    clearOwnerSessionToken();
    throw contractError("Vault 未返回 owner session token", payload);
  }
  setOwnerSessionToken(payload.owner_token);
  return payload;
}

function asStudySpaceWire(payload: unknown, context: string): StudySpaceWire {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    name: expectString(record.name, `${context}.name`),
    topic: expectString(record.topic, `${context}.topic`),
    goal: expectString(record.goal, `${context}.goal`),
    default_character_pack_id: expectNullableString(
      record.default_character_pack_id,
      `${context}.default_character_pack_id`,
    ),
    created_at: expectString(record.created_at, `${context}.created_at`),
    updated_at: expectString(record.updated_at, `${context}.updated_at`),
  };
}

function asMaterialWire(payload: unknown, context: string): SpaceDetailResponseWire["materials"][number] {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    space_id: expectString(record.space_id, `${context}.space_id`),
    title: expectString(record.title, `${context}.title`),
    kind: expectMaterialKind(record.kind, `${context}.kind`),
    filename: expectString(record.filename, `${context}.filename`),
    chunk_count: (() => {
      if (typeof record.chunk_count !== "number" || Number.isNaN(record.chunk_count)) {
        throw contractError(`${context}.chunk_count 字段无效`, record.chunk_count);
      }
      return record.chunk_count;
    })(),
    created_at: expectString(record.created_at, `${context}.created_at`),
    updated_at: expectString(record.updated_at, `${context}.updated_at`),
  };
}

function asIngestionJobWire(payload: unknown, context: string): SpaceDetailResponseWire["jobs"][number] {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    space_id: expectString(record.space_id, `${context}.space_id`),
    material_id: expectString(record.material_id, `${context}.material_id`),
    status: expectString(record.status, `${context}.status`),
    error_message: expectNullableString(record.error_message, `${context}.error_message`),
    created_at: expectString(record.created_at, `${context}.created_at`),
    updated_at: expectString(record.updated_at, `${context}.updated_at`),
  };
}

function asModelAssignmentWire(payload: unknown, context: string): ModelAssignmentWire {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    space_id: expectString(record.space_id, `${context}.space_id`),
    capability: asProviderCapability(record.capability, `${context}.capability`),
    provider_connection_id: expectString(
      record.provider_connection_id,
      `${context}.provider_connection_id`,
    ),
    model_name: expectString(record.model_name, `${context}.model_name`),
    created_at: expectString(record.created_at, `${context}.created_at`),
    updated_at: expectString(record.updated_at, `${context}.updated_at`),
  };
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

function asRealtimeEvent(payload: unknown, context: string): RealtimeEventWire {
  const record = expectRecord(payload, context);
  return {
    type: expectString(record.type, `${context}.type`),
    session_id: expectString(record.session_id, `${context}.session_id`),
    state:
      record.state === null
        ? null
        : expectString(record.state, `${context}.state`) as RealtimeEventWire["state"],
    payload: expectRecord(record.payload, `${context}.payload`),
  };
}

function eventErrorMessage(event: RealtimeEventWire): string | null {
  if (typeof event.payload.message === "string") {
    return event.payload.message;
  }
  if (typeof event.payload.text === "string") {
    return event.payload.text;
  }
  return null;
}

function toStudySpaceSummary(
  space: StudySpaceWire,
  extras: {
    materialCount?: number;
    sessionCount?: number;
    assignments?: ModelAssignmentWire[];
  } = {},
): StudySpaceSummary {
  return {
    id: space.id,
    title: space.name,
    theme: space.topic,
    goal: space.goal,
    default_character_id: space.default_character_pack_id,
    material_count: extras.materialCount,
    session_count: extras.sessionCount,
    knowledge_status:
      extras.materialCount === undefined ? undefined : extras.materialCount > 0 ? "ready" : "blank",
    model_assignments: extras.assignments?.map(toModelAssignmentView),
    created_at: space.created_at,
    updated_at: space.updated_at,
  };
}

function toMaterialRecord(material: SpaceDetailResponseWire["materials"][number]): MaterialRecord {
  return {
    id: material.id,
    title: material.title,
    filename: material.filename,
    kind: material.kind,
    chunk_count: material.chunk_count,
    created_at: material.created_at,
    updated_at: material.updated_at,
  };
}

function toIngestionJob(job: SpaceDetailResponseWire["jobs"][number]): IngestionJob {
  return {
    id: job.id,
    status: job.status,
    material_id: job.material_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
    detail: job.error_message,
  };
}

function toModelAssignmentView(assignment: ModelAssignmentWire): ModelAssignment {
  return {
    capability: assignment.capability,
    connection_id: assignment.provider_connection_id,
    model: assignment.model_name,
  };
}

function toSpaceDetail(payload: SpaceDetailResponseWire): StudySpaceDetail {
  return {
    ...toStudySpaceSummary(payload.space, {
      materialCount: payload.materials.length,
      assignments: payload.assignments,
    }),
    materials: payload.materials.map(toMaterialRecord),
    jobs: payload.jobs.map(toIngestionJob),
  };
}

function asMaterialIngestionResponse(payload: unknown, context: string): MaterialIngestionResponseWire {
  const record = expectRecord(payload, context);
  return {
    material: asMaterialWire(record.material, `${context}.material`),
    job: asIngestionJobWire(record.job, `${context}.job`),
  };
}

function asLegacyKnowledgeCandidate(
  payload: unknown,
  context: string,
): LegacyKnowledgeCandidate {
  const record = expectRecord(payload, context);
  return {
    document_id: expectString(record.document_id, `${context}.document_id`),
    filename: expectString(record.filename, `${context}.filename`),
    title: expectString(record.title, `${context}.title`),
    source_type: expectString(record.source_type, `${context}.source_type`),
    chunk_count: expectNumber(record.chunk_count, `${context}.chunk_count`),
    importable: expectBoolean(record.importable, `${context}.importable`),
    issue: record.issue == null ? null : expectString(record.issue, `${context}.issue`),
  };
}

function asLegacyKnowledgeImportResult(
  payload: unknown,
  context: string,
): LegacyKnowledgeImportResult {
  const record = expectRecord(payload, context);
  return {
    document_id: expectString(record.document_id, `${context}.document_id`),
    space_id: expectString(record.space_id, `${context}.space_id`),
    material_id: expectString(record.material_id, `${context}.material_id`),
    filename: expectString(record.filename, `${context}.filename`),
    title: expectString(record.title, `${context}.title`),
    kind: expectMaterialKind(record.kind, `${context}.kind`),
    chunk_count: expectNumber(record.chunk_count, `${context}.chunk_count`),
    status: expectString(record.status, `${context}.status`),
    already_imported: expectBoolean(record.already_imported, `${context}.already_imported`),
  };
}

function encodeFilenameHeaderValue(filename: string): string {
  return encodeURIComponent(filename);
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

function asCharacterRecipeDefaults(payload: unknown, context: string): CharacterRecipe {
  const record = expectRecord(payload, context);
  const palette = expectRecord(record.palette, `${context}.palette`);
  const motions = expectRecord(record.motions, `${context}.motions`);
  return {
    avatar_model: expectString(record.avatar_model, `${context}.avatar_model`),
    avatar_framing: asAvatarFraming(record.avatar_framing, `${context}.avatar_framing`),
    stage_background: asAvatarStageBackground(
      record.stage_background,
      `${context}.stage_background`,
    ),
    base_model: expectString(record.base_model, `${context}.base_model`),
    face_style: expectString(record.face_style, `${context}.face_style`),
    hairstyle: expectString(record.hairstyle, `${context}.hairstyle`),
    outfit: expectString(record.outfit, `${context}.outfit`),
    accessories: expectStringArray(record.accessories, `${context}.accessories`),
    palette: Object.fromEntries(
      Object.entries(palette).map(([key, value]) => [
        key,
        expectString(value, `${context}.palette.${key}`),
      ]),
    ),
    personality: expectString(record.personality, `${context}.personality`),
    warmth: expectNumber(record.warmth, `${context}.warmth`),
    initiative: expectNumber(record.initiative, `${context}.initiative`),
    humor: expectNumber(record.humor, `${context}.humor`),
    challenge: expectNumber(record.challenge, `${context}.challenge`),
    relationship_role: expectString(record.relationship_role, `${context}.relationship_role`),
    voice_provider: expectString(record.voice_provider, `${context}.voice_provider`),
    voice_model: expectString(record.voice_model, `${context}.voice_model`),
    voice_id: expectString(record.voice_id, `${context}.voice_id`),
    speaking_rate: expectNumber(record.speaking_rate, `${context}.speaking_rate`),
    motions: Object.fromEntries(
      Object.entries(motions).map(([key, value]) => [
        key,
        expectString(value, `${context}.motions.${key}`),
      ]),
    ),
  };
}

function expectOptionalNullableString(
  value: unknown,
  context: string,
): string | null | undefined {
  return value === undefined ? undefined : expectNullableString(value, context);
}

function expectTtsPlaybackPolicy(
  value: unknown,
  context: string,
): TtsPlaybackPolicy | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (value === "browser-compat" || value === "server-neural" || value === "server") {
    return value;
  }
  throw contractError(`${context} 字段无效`, value);
}

function decodeSessionRecordWire(payload: unknown, context: string): SessionRecordWire {
  const record = expectRecord(payload, context);
  return {
    ...(record as unknown as SessionRecordWire),
    character_pack_id: expectNullableString(
      record.character_pack_id,
      `${context}.character_pack_id`,
    ),
    tts_connection_id: expectOptionalNullableString(
      record.tts_connection_id,
      `${context}.tts_connection_id`,
    ),
    tts_model_name: expectOptionalNullableString(
      record.tts_model_name,
      `${context}.tts_model_name`,
    ),
    tts_playback_policy: expectTtsPlaybackPolicy(
      record.tts_playback_policy,
      `${context}.tts_playback_policy`,
    ),
  };
}

function asMobilePairingChallenge(payload: unknown): MobilePairingChallenge {
  const record = expectRecord(payload, "移动设备配对码接口");
  const code = expectString(record.code, "移动设备配对码接口.code");
  const attemptsAllowed = expectNumber(
    record.attempts_allowed,
    "移动设备配对码接口.attempts_allowed",
  );
  if (!/^\d{8}$/.test(code) || !Number.isInteger(attemptsAllowed) || attemptsAllowed < 1) {
    throw contractError("移动设备配对码接口字段无效", payload);
  }
  return {
    challenge_id: expectString(record.challenge_id, "移动设备配对码接口.challenge_id"),
    code,
    expires_at: expectDateTimeString(record.expires_at, "移动设备配对码接口.expires_at"),
    attempts_allowed: attemptsAllowed,
  };
}

function asMobileDevice(payload: unknown, context: string): MobileDevice {
  const record = expectRecord(payload, context);
  return {
    id: expectString(record.id, `${context}.id`),
    name: expectString(record.name, `${context}.name`),
    refresh_expires_at: expectDateTimeString(
      record.refresh_expires_at,
      `${context}.refresh_expires_at`,
    ),
    created_at: expectDateTimeString(record.created_at, `${context}.created_at`),
    last_seen_at: expectDateTimeString(record.last_seen_at, `${context}.last_seen_at`),
  };
}

function asAvatarFraming(value: unknown, context: string): AvatarFraming {
  if (value === undefined) {
    return "full_body";
  }
  if (value === "full_body" || value === "portrait") {
    return value;
  }
  throw contractError(context, "must be full_body or portrait");
}

function asAvatarStageBackground(value: unknown, context: string): AvatarStageBackground {
  if (value === undefined) {
    return "neutral";
  }
  if (value === "neutral" || value === "study" || value === "midnight") {
    return value;
  }
  throw contractError(context, "must be neutral, study, or midnight");
}

function asApiCharacterRecipe(recipe: unknown, context: string): CharacterRecipe {
  const record = expectRecord(recipe, context);
  return {
    ...(record as unknown as CharacterRecipe),
    stage_background: asAvatarStageBackground(
      record.stage_background,
      `${context}.stage_background`,
    ),
  };
}

const DEFAULT_CHARACTER_RECIPE = asCharacterRecipeDefaults(
  defaultCharacterRecipeSeed,
  "默认角色配方",
);
const DEFAULT_NOVA_CHARACTER_RECIPE = asCharacterRecipeDefaults(
  defaultNovaCharacterRecipeSeed,
  "默认 Nova 角色配方",
);

function toCharacterSummary(character: CharacterPackWire): CharacterPackSummary {
  const recipe = asApiCharacterRecipe(character.recipe, "角色接口.recipe");
  return {
    id: character.id,
    name: character.name,
    archetype: recipe.relationship_role,
    style: recipe.personality,
    updated_at: character.updated_at,
  };
}

function toCharacterDetail(character: CharacterPackWire): CharacterPackDetail {
  const assetManifest = character.asset_manifest;
  const licenseSummary = [
    assetManifest.license_summary,
    assetManifest.redistribution_note,
    assetManifest.license,
    assetManifest.render_mode,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    ...toCharacterSummary(character),
    description: character.description,
    recipe: asApiCharacterRecipe(character.recipe, "角色详情接口.recipe"),
    asset_manifest: assetManifest,
    license_summary: licenseSummary ?? null,
  };
}

export function createDefaultCharacterRecipe(
  seed: Partial<CharacterRecipe> = {},
): CharacterRecipe {
  return {
    ...DEFAULT_CHARACTER_RECIPE,
    avatar_model: seed.avatar_model ?? DEFAULT_CHARACTER_RECIPE.avatar_model,
    avatar_framing: seed.avatar_framing ?? DEFAULT_CHARACTER_RECIPE.avatar_framing,
    stage_background: asAvatarStageBackground(
      seed.stage_background,
      "角色配方.stage_background",
    ),
    base_model: seed.base_model ?? DEFAULT_CHARACTER_RECIPE.base_model,
    face_style: seed.face_style ?? DEFAULT_CHARACTER_RECIPE.face_style,
    hairstyle: seed.hairstyle ?? DEFAULT_CHARACTER_RECIPE.hairstyle,
    outfit: seed.outfit ?? DEFAULT_CHARACTER_RECIPE.outfit,
    accessories: [...(seed.accessories ?? DEFAULT_CHARACTER_RECIPE.accessories)],
    personality: seed.personality ?? DEFAULT_CHARACTER_RECIPE.personality,
    relationship_role: seed.relationship_role ?? DEFAULT_CHARACTER_RECIPE.relationship_role,
    warmth: seed.warmth ?? DEFAULT_CHARACTER_RECIPE.warmth,
    initiative: seed.initiative ?? DEFAULT_CHARACTER_RECIPE.initiative,
    humor: seed.humor ?? DEFAULT_CHARACTER_RECIPE.humor,
    challenge: seed.challenge ?? DEFAULT_CHARACTER_RECIPE.challenge,
    voice_provider: seed.voice_provider ?? DEFAULT_CHARACTER_RECIPE.voice_provider,
    voice_model: seed.voice_model ?? DEFAULT_CHARACTER_RECIPE.voice_model,
    voice_id: seed.voice_id ?? DEFAULT_CHARACTER_RECIPE.voice_id,
    speaking_rate: seed.speaking_rate ?? DEFAULT_CHARACTER_RECIPE.speaking_rate,
    palette: {
      ...DEFAULT_CHARACTER_RECIPE.palette,
      ...(seed.palette ?? {}),
    },
    motions: { ...(seed.motions ?? DEFAULT_CHARACTER_RECIPE.motions) },
  };
}

export function createDefaultNovaCharacterRecipe(): CharacterRecipe {
  return createDefaultCharacterRecipe(DEFAULT_NOVA_CHARACTER_RECIPE);
}

export function createCharacterWorkshopDocument(input: {
  name: string;
  description?: string | null;
  recipe: CharacterRecipe;
  preview_state?: CharacterWorkshopDocument["preview_state"];
  voice_preview_text?: CharacterWorkshopDocument["voice_preview_text"];
}): CharacterWorkshopDocument {
  return {
    schema_version: "character_recipe_v1",
    exported_at: new Date().toISOString(),
    name: input.name,
    description: input.description ?? "",
    recipe: createDefaultCharacterRecipe(input.recipe),
    preview_state: input.preview_state ?? "idle",
    voice_preview_text: input.voice_preview_text ?? "",
  };
}

function toSessionSummary(
  session: SessionRecordWire,
  options: { spaceTitle?: string; turnCount?: number } = {},
): SessionSummary {
  const sessionTitle = options.spaceTitle
    ? `${options.spaceTitle} · 会话复盘`
    : "会话复盘";
  return {
    id: session.id,
    title: sessionTitle,
    space_id: session.space_id,
    character_pack_id: expectNullableString(
      session.character_pack_id,
      "session.character_pack_id",
    ),
    space_title: options.spaceTitle,
    state: session.state,
    turn_count: options.turnCount,
    tts_connection_id: session.tts_connection_id,
    tts_model_name: session.tts_model_name,
    tts_playback_policy: session.tts_playback_policy,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function toSessionDetail(
  payload: SessionTranscriptResponseWire,
  options: { spaceTitle?: string } = {},
): SessionDetail {
  return {
    ...toSessionSummary(payload.session, {
      turnCount: payload.turns.length,
      spaceTitle: options.spaceTitle,
    }),
    transcript: payload.turns,
    summary: payload.session.summary,
    generated_summary: payload.session.generated_summary ?? payload.session.summary,
    notes: payload.session.notes ?? "",
    artifacts_status: payload.session.artifacts_status ?? "idle",
    artifacts_error: payload.session.artifacts_error ?? null,
    artifacts_updated_at: payload.session.artifacts_updated_at ?? null,
    memory_candidates: (payload.memory_candidates ?? []).map(toMemoryView),
    review_items: (payload.review_items ?? []).map(toReviewView),
  };
}

function toMemoryView(item: MemoryItemWire): MemoryItem {
  memoryItemsById.set(scopedItemKey(item.space_id, item.id), item);
  return {
    id: item.id,
    space_id: item.space_id,
    content: item.content,
    confirmed: item.status === "confirmed",
    sensitivity: item.sensitive ? "sensitive" : "normal",
    source_session_id: item.source_session_id ?? null,
    created_at: item.created_at,
  };
}

function toReviewView(item: ReviewItemWire): ReviewItem {
  reviewItemsById.set(scopedItemKey(item.space_id, item.id), item);
  return {
    id: item.id,
    space_id: item.space_id,
    prompt: item.prompt,
    answer: item.answer,
    due_at: item.due_at,
    status: item.status === "completed" ? "done" : "pending",
    source_session_id: item.source_session_id ?? null,
    created_at: item.created_at,
  };
}

function toReviewStatus(value: string | null | undefined, current: ReviewStatus): ReviewStatus {
  if (value === undefined || value === null) {
    return current;
  }
  if (value === "done" || value === "completed") {
    return "completed";
  }
  if (value === "pending") {
    return "pending";
  }
  throw new ApiError(`不支持的复习状态：${value}`, 400, { status: value });
}

function toSpaceCreatePayload(
  input: StudySpaceCreateInput | LegacyStudySpaceCreateInput,
): StudySpaceCreateInput {
  if ("name" in input) {
    return {
      name: input.name,
      topic: input.topic ?? "",
      goal: input.goal ?? "",
    };
  }
  return {
    name: input.title,
    topic: input.theme ?? "",
    goal: input.goal ?? "",
  };
}

function toSpaceUpdatePayload(
  input: StudySpaceUpdateInput | LegacyStudySpaceUpdateInput,
): StudySpaceUpdateInput {
  if ("name" in input) {
    return {
      name: input.name,
      topic: input.topic ?? "",
      goal: input.goal ?? "",
    };
  }
  if (!input.title) {
    throw new ApiError("更新空间时必须提供 name/title", 400, input);
  }
  return {
    name: input.title,
    topic: input.theme ?? "",
    goal: input.goal ?? "",
  };
}

async function loadSpacesWire(): Promise<StudySpaceWire[]> {
  const payload = await request<unknown>("/api/v1/spaces");
  return expectArray<unknown>(payload, "空间列表接口").map((item, index) =>
    asStudySpaceWire(item, `空间列表接口[${index}]`)
  );
}

async function loadMemoryItemsWire(spaceId: string): Promise<MemoryItemWire[]> {
  const payload = await request<unknown>(`/api/v1/memory/${spaceId}`);
  const items = expectArrayField<MemoryItemWire>(payload, "items", "记忆列表接口");
  for (const item of items) {
    if (item.space_id !== spaceId) {
      throw contractError("记忆接口返回了其他空间的数据，已拒绝缓存", item);
    }
    memoryItemsById.set(scopedItemKey(spaceId, item.id), item);
  }
  return items;
}

async function loadReviewItemsWire(spaceId: string): Promise<ReviewItemWire[]> {
  const payload = await request<unknown>(`/api/v1/review-items/${spaceId}`);
  const items = expectArrayField<ReviewItemWire>(payload, "items", "复习项列表接口");
  for (const item of items) {
    if (item.space_id !== spaceId) {
      throw contractError("复习项接口返回了其他空间的数据，已拒绝缓存", item);
    }
    reviewItemsById.set(scopedItemKey(spaceId, item.id), item);
  }
  return items;
}

async function resolveMemoryItem(memoryId: string, spaceId: string): Promise<MemoryItemWire> {
  const cached = memoryItemsById.get(scopedItemKey(spaceId, memoryId));
  if (cached && cached.space_id === spaceId) {
    return cached;
  }
  const item = (await loadMemoryItemsWire(spaceId)).find((candidate) => candidate.id === memoryId);
  if (item) {
    return item;
  }
  throw new ApiError("当前空间中不存在该记忆项", 404, {
    memory_id: memoryId,
    space_id: spaceId,
  });
}

async function resolveReviewItem(reviewId: string, spaceId: string): Promise<ReviewItemWire> {
  const cached = reviewItemsById.get(scopedItemKey(spaceId, reviewId));
  if (cached && cached.space_id === spaceId) {
    return cached;
  }
  const item = (await loadReviewItemsWire(spaceId)).find((candidate) => candidate.id === reviewId);
  if (item) {
    return item;
  }
  throw new ApiError("当前空间中不存在该复习项", 404, {
    review_id: reviewId,
    space_id: spaceId,
  });
}

export async function getVaultStatus() {
  const payload = await request<unknown>("/api/v1/vault/status", { auth: "none" });
  return asVaultStatus(payload);
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

export async function getOwnerPreferences() {
  const payload = await request<OwnerPreferencesWire>("/api/v1/vault/preferences");
  return asOwnerPreferences(payload);
}

export async function updateOwnerPreferences(input: {
  adult_relationships_enabled: boolean;
  confirm_age_18_or_older: boolean;
}) {
  const payload = await request<OwnerPreferencesWire>("/api/v1/vault/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return asOwnerPreferences(payload);
}

export async function createMobilePairingChallenge() {
  const payload = await request<unknown>("/api/v1/mobile/pairing-challenges", {
    method: "POST",
  });
  return asMobilePairingChallenge(payload);
}

export async function listMobileDevices() {
  const payload = await request<unknown>("/api/v1/mobile/devices");
  return expectArray<unknown>(payload, "移动设备列表接口").map((device, index) =>
    asMobileDevice(device, `移动设备列表接口[${index}]`)
  );
}

export async function revokeMobileDevice(deviceId: string) {
  await request<null>(`/api/v1/mobile/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export async function getLocalMetricsSummary() {
  const payload = await request<unknown>("/api/v1/metrics/local/summary");
  return asLocalMetricsSummary(payload);
}

export async function postLocalMetricSignal(input: LocalMetricSignalInput) {
  await request<null>("/api/v1/metrics/local/signals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function postLocalMetricSignalSafe(input: LocalMetricSignalInput) {
  try {
    await postLocalMetricSignal(input);
  } catch (error) {
    console.warn("Local metric signal failed", {
      event: input.event,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function initializeVault(input: { password: string }) {
  const payload = await request<VaultUnlockResponse>("/api/v1/vault/init", {
    method: "POST",
    auth: "none",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return storeOwnerSession(payload);
}

export async function unlockVault(input: { password: string }) {
  const payload = await request<VaultUnlockResponse>("/api/v1/vault/unlock", {
    method: "POST",
    auth: "none",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return storeOwnerSession(payload);
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

export function getRealtimeOwnerToken(): string | null {
  return getOwnerSessionToken();
}

export async function listSpaces() {
  return (await loadSpacesWire()).map((space) => toStudySpaceSummary(space));
}

export async function createSpace(
  input: StudySpaceCreateInput | LegacyStudySpaceCreateInput,
) {
  const payload = await request<StudySpaceWire>("/api/v1/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toSpaceCreatePayload(input)),
  });
  return toStudySpaceSummary(payload);
}

export async function getSpace(spaceId: string) {
  const payload = await request<unknown>(`/api/v1/spaces/${spaceId}`);
  const record = expectRecord(payload, "空间详情接口");
  return toSpaceDetail({
    space: asStudySpaceWire(record.space, "空间详情接口.space"),
    materials: expectArray<unknown>(record.materials, "空间详情接口.materials").map((item, index) =>
      asMaterialWire(item, `空间详情接口.materials[${index}]`)
    ),
    jobs: expectArray<unknown>(record.jobs, "空间详情接口.jobs").map((item, index) =>
      asIngestionJobWire(item, `空间详情接口.jobs[${index}]`)
    ),
    assignments: expectArray<unknown>(record.assignments, "空间详情接口.assignments").map((item, index) =>
      asModelAssignmentWire(item, `空间详情接口.assignments[${index}]`)
    ),
  });
}

export async function updateSpace(
  spaceId: string,
  input: StudySpaceUpdateInput | LegacyStudySpaceUpdateInput,
) {
  const payload = await request<StudySpaceWire>(`/api/v1/spaces/${spaceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toSpaceUpdatePayload(input)),
  });
  return toStudySpaceSummary(payload);
}

export async function setSpaceDefaultCharacter(
  spaceId: string,
  characterPackId: string | null,
) {
  const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/default-character`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character_pack_id: characterPackId }),
  });
  return toStudySpaceSummary(
    asStudySpaceWire(payload, "空间默认角色更新接口"),
  );
}

export async function deleteSpace(spaceId: string) {
  return request<null>(`/api/v1/spaces/${spaceId}`, { method: "DELETE" });
}

export async function uploadMaterial(input: {
  spaceId: string;
  file: File;
}) {
  const payload = await request<unknown>(`/api/v1/spaces/${input.spaceId}/materials/upload`, {
    method: "POST",
    headers: {
      "Content-Type": input.file.type || "application/octet-stream",
      "X-Filename": encodeFilenameHeaderValue(input.file.name),
    },
    body: input.file,
  });
  return asMaterialIngestionResponse(payload, "资料上传接口");
}

export async function createNoteMaterial(input: {
  spaceId: string;
  title: string;
  content: string;
}) {
  const payload = await request<unknown>(`/api/v1/spaces/${input.spaceId}/materials/note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, content: input.content }),
  });
  return asMaterialIngestionResponse(payload, "直接笔记入库接口");
}

export async function deleteMaterial(spaceId: string, materialId: string) {
  return request<null>(`/api/v1/spaces/${spaceId}/materials/${materialId}`, {
    method: "DELETE",
  });
}

export async function retryMaterialIngestion(spaceId: string, materialId: string) {
  const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/materials/${materialId}/retry`, {
    method: "POST",
  });
  return asMaterialIngestionResponse(payload, "资料重试接口");
}

export async function listLegacyKnowledgeCandidates() {
  const payload = await request<unknown>("/api/v1/legacy-knowledge-base");
  return expectArrayField<unknown>(payload, "items", "旧知识库候选接口").map((item, index) =>
    asLegacyKnowledgeCandidate(item, `旧知识库候选接口.items[${index}]`)
  );
}

export async function importLegacyKnowledge(spaceId: string, documentId: string) {
  const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/legacy-knowledge-base/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_id: documentId }),
  });
  return asLegacyKnowledgeImportResult(payload, "旧知识库导入接口");
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

export async function saveSpaceAssignment(
  spaceId: string,
  input: {
    capability: ProviderCapability;
    provider_connection_id: string;
    model_name: string;
  },
) {
  const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return asModelAssignmentWire(payload, "空间能力绑定接口");
}

export async function deleteSpaceAssignment(
  spaceId: string,
  capability: ProviderCapability,
) {
  return request<null>(`/api/v1/spaces/${spaceId}/assignments/${capability}`, {
    method: "DELETE",
  });
}

export async function listCharacters() {
  const payload = await request<unknown>("/api/v1/characters");
  return expectArrayField<CharacterPackWire>(payload, "items", "角色列表接口").map(
    toCharacterSummary,
  );
}

export async function createCharacter(input: CharacterCreateInput | LegacyCharacterCreateInput) {
  const recipe =
    "recipe" in input && input.recipe
      ? createDefaultCharacterRecipe(input.recipe)
      : createDefaultCharacterRecipe({
          face_style: "style" in input && input.style ? input.style : DEFAULT_CHARACTER_RECIPE.face_style,
          personality:
            "style" in input && input.style ? input.style : DEFAULT_CHARACTER_RECIPE.personality,
          relationship_role:
            "archetype" in input && input.archetype
              ? input.archetype
              : DEFAULT_CHARACTER_RECIPE.relationship_role,
        });
  const payload = await request<CharacterPackWire>("/api/v1/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: "description" in input ? input.description ?? "" : "",
      recipe,
    }),
  });
  return toCharacterSummary(payload);
}

export async function getCharacter(characterId: string) {
  const payload = await request<CharacterPackWire>(`/api/v1/characters/${characterId}`);
  return toCharacterDetail(payload);
}

export async function updateCharacter(
  characterId: string,
  input: Partial<CharacterPackDetail>,
) {
  const payload = await request<CharacterPackWire>(`/api/v1/characters/${characterId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      recipe: input.recipe ? createDefaultCharacterRecipe(input.recipe) : undefined,
    }),
  });
  return toCharacterDetail(payload);
}

export async function duplicateCharacter(characterId: string, input: { name?: string } = {}) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/duplicate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return toCharacterSummary(payload);
}

export async function deleteCharacter(characterId: string) {
  return request<null>(`/api/v1/characters/${characterId}`, { method: "DELETE" });
}

export async function importCharacter(file: File) {
  const isCharacterCard = file.name.toLowerCase().endsWith(".json");
  const sizeLimit = isCharacterCard
    ? MAX_CHARACTER_CARD_SIZE_BYTES
    : MAX_CHARACTER_PACK_SIZE_BYTES;
  if (file.size > sizeLimit) {
    throw new ApiError(
      isCharacterCard ? "角色卡 JSON 超过 1 MB 上限" : "角色包超过 200 MiB 上限",
      413,
      {
        size: file.size,
        limit: sizeLimit,
      },
    );
  }
  const payload = await request<CharacterPackWire>("/api/v1/characters/import", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeFilenameHeaderValue(file.name),
    },
    body: file,
  });
  return toCharacterDetail(payload);
}

export async function replaceCharacterAvatar(characterId: string, file: File) {
  if (!file.name.toLowerCase().endsWith(".vrm")) {
    throw new ApiError("请选择 .vrm 模型文件", 400, { filename: file.name });
  }
  if (file.size > MAX_CHARACTER_PACK_SIZE_BYTES) {
    throw new ApiError("角色模型超过 200 MiB 上限", 413, {
      size: file.size,
      limit: MAX_CHARACTER_PACK_SIZE_BYTES,
    });
  }
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/avatar`,
    {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeFilenameHeaderValue(file.name),
      },
      body: file,
    },
  );
  return toCharacterDetail(payload);
}

export async function removeCharacterAvatar(characterId: string) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/avatar`,
    { method: "DELETE" },
  );
  return toCharacterDetail(payload);
}

export async function replaceCharacterMotion(
  characterId: string,
  state: CharacterPreviewState,
  file: File,
) {
  if (!file.name.toLowerCase().endsWith(".vrma")) {
    throw new ApiError("Please select a .vrma motion file", 400, { filename: file.name });
  }
  if (file.size > MAX_CHARACTER_PACK_SIZE_BYTES) {
    throw new ApiError("Character motion exceeds the 200 MiB limit", 413, {
      size: file.size,
      limit: MAX_CHARACTER_PACK_SIZE_BYTES,
    });
  }
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/motions/${state}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeFilenameHeaderValue(file.name),
      },
      body: file,
    },
  );
  return toCharacterDetail(payload);
}

export async function removeCharacterMotion(
  characterId: string,
  state: CharacterPreviewState,
) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/motions/${state}`,
    { method: "DELETE" },
  );
  return toCharacterDetail(payload);
}

export async function downloadCharacterPack(characterId: string) {
  const response = await requestBinary(
    `/api/v1/characters/${characterId}/export`,
    { method: "GET" },
    "导出角色包失败",
  );
  return response.blob();
}

export async function downloadCharacterAsset(characterId: string, assetPath: string) {
  const encodedPath = assetPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await requestBinary(
    `/api/v1/characters/${characterId}/assets/${encodedPath}`,
    { method: "GET" },
    "读取角色资产失败",
  );
  return response.blob();
}

export async function previewCharacterVoice(input: {
  characterId: string;
  spaceId: string;
  text: string;
  voiceId?: string;
  speakingRate?: number;
  signal?: AbortSignal;
}) {
  const response = await requestBinary(
    `/api/v1/characters/${input.characterId}/voice-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        space_id: input.spaceId,
        text: input.text,
        voice_id: input.voiceId,
        speaking_rate: input.speakingRate,
      }),
      signal: input.signal,
    },
    "角色声音试听失败",
  );
  return {
    pcm16: await response.arrayBuffer(),
    sampleRate: Number(response.headers.get("x-audio-sample-rate") ?? "24000"),
  };
}

export async function createSessionDemo(
  sessionId: string,
  input: SessionDemoRequestInput,
): Promise<SessionDemoResponseWire> {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/demos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const decoded = decodeSessionDemoResponse(payload);
  if (!decoded) {
    throw contractError("演示生成接口返回了无效脚本载荷", payload);
  }
  return decoded;
}

export async function createSession(input: {
  space_id: string;
  character_pack_id?: string | null;
}) {
  const payload = await request<unknown>("/api/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return decodeSessionRecordWire(payload, "会话创建接口");
}

export async function createTurn(sessionId: string, text: string) {
  return request<CompanionTurn>(`/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function streamTurn(
  sessionId: string,
  text: string,
  onEvent: (event: RealtimeEventWire) => void,
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = isNativeOwnerSessionRuntime()
    ? await ensureNativeOwnerSessionToken()
    : getOwnerSessionToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else if (isNativeOwnerSessionRuntime()) {
    throw new ApiError("Mobile owner session refresh required", 401, null);
  }

  const response = await fetch(apiUrl(`/api/v1/sessions/${sessionId}/turns/stream`), {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
    cache: "no-store",
  });

  if (!response.ok) {
    const parsed = await parseResponse(response);
    if (isOwnerAuthFailure(response.status, parsed)) {
      clearOwnerSessionToken({
        notifyOtherTabs:
          isRecord(parsed) && parsed.detail === "Vault is locked",
      });
    }
    throw new ApiError(errorMessage(parsed, "流式会话启动失败"), response.status, parsed);
  }

  if (!response.body) {
    throw contractError("流式会话接口没有返回可读数据流", response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function flushLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw contractError("流式会话接口返回了无效 NDJSON 行", rawLine);
    }
    const event = asRealtimeEvent(parsed, "流式会话接口");
    if (event.type === "error") {
      throw new ApiError(
        eventErrorMessage(event) ?? "流式会话返回 error 事件",
        502,
        event.payload,
      );
    }
    onEvent(event);
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      await flushLine(line);
    }
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    await flushLine(buffer);
  }
}

export async function createRealtimeTicket(sessionId: string) {
  const payload = await request<unknown>(
    `/api/v1/sessions/${sessionId}/realtime-ticket`,
    { method: "POST" },
  );
  const record = expectRecord(payload, "实时会话票据接口");
  if (typeof record.ticket !== "string" || typeof record.expires_at !== "string") {
    throw contractError("实时会话票据接口字段无效", payload);
  }
  return record as unknown as RealtimeTicketResponseWire;
}

export async function listSessions(spaceId?: string) {
  if (spaceId) {
    const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/sessions`);
    return expectArray<unknown>(payload, "会话列表接口").map((value) => {
      const session = decodeSessionRecordWire(value, "会话列表接口.session");
      if (session.space_id !== spaceId) {
        throw contractError("会话接口返回了其他空间的数据，已拒绝展示", session);
      }
      return toSessionSummary(session);
    });
  }

  const spaces = await loadSpacesWire();
  const sessionsBySpace = await Promise.all(
    spaces.map(async (space) => {
      const payload = await request<unknown>(`/api/v1/spaces/${space.id}/sessions`);
      return expectArray<unknown>(payload, "会话列表接口").map((value) => {
        const session = decodeSessionRecordWire(value, "会话列表接口.session");
        if (session.space_id !== space.id) {
          throw contractError("会话接口返回了其他空间的数据，已拒绝聚合", session);
        }
        return toSessionSummary(session, { spaceTitle: space.name });
      });
    }),
  );
  return sessionsBySpace.flat();
}

export async function getSession(sessionId: string) {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}`);
  const record = expectRecord(payload, "会话详情接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话详情接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话详情接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}

export async function endSession(sessionId: string, summary = "") {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary }),
  });
  return decodeSessionRecordWire(payload, "会话结束接口");
}

export async function saveSessionRecap(
  sessionId: string,
  input: { summary: string; notes: string },
) {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/recap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const record = expectRecord(payload, "会话复盘保存接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话复盘保存接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话复盘保存接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}

export async function undoSessionRecap(sessionId: string) {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/recap/undo`, {
    method: "POST",
  });
  const record = expectRecord(payload, "会话复盘撤销接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话复盘撤销接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话复盘撤销接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}

export async function listMemoryItems(spaceId: string) {
  return (await loadMemoryItemsWire(spaceId)).map(toMemoryView);
}

export async function confirmMemoryItem(memoryId: string, spaceId: string) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const payload = await request<MemoryItemWire>(
    `/api/v1/memory/${current.space_id}/${memoryId}/confirm`,
    {
      method: "POST",
    },
  );
  return toMemoryView(payload);
}

export async function updateMemoryItem(
  memoryId: string,
  input: MemoryUpdateInput,
  spaceId: string,
) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const nextStatus =
    "status" in input && input.status
      ? input.status
      : "confirmed" in input && input.confirmed !== undefined
        ? input.confirmed
          ? "confirmed"
          : "candidate"
        : current.status;
  const nextSensitive =
    "sensitive" in input && input.sensitive !== undefined
      ? input.sensitive
      : "sensitivity" in input && input.sensitivity !== undefined
        ? input.sensitivity === "sensitive"
        : current.sensitive;
  const payload = await request<MemoryItemWire>(
    `/api/v1/memory/${current.space_id}/${memoryId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: input.content ?? current.content,
        status: nextStatus,
        sensitive: nextSensitive,
      }),
    },
  );
  return toMemoryView(payload);
}

export async function deleteMemoryItem(memoryId: string, spaceId: string) {
  const current = await resolveMemoryItem(memoryId, spaceId);
  const result = await request<null>(`/api/v1/memory/${current.space_id}/${memoryId}`, {
    method: "DELETE",
  });
  memoryItemsById.delete(scopedItemKey(spaceId, memoryId));
  return result;
}

export async function listReviewItems(spaceId: string) {
  return (await loadReviewItemsWire(spaceId)).map(toReviewView);
}

export async function updateReviewItem(
  reviewId: string,
  input: ReviewUpdateInput,
  spaceId: string,
) {
  const current = await resolveReviewItem(reviewId, spaceId);
  const requestedStatus = "status" in input ? input.status : undefined;
  const status = toReviewStatus(requestedStatus, current.status);
  const payload = await request<ReviewItemWire>(
    `/api/v1/review-items/${current.space_id}/${reviewId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt ?? current.prompt,
        answer: input.answer ?? current.answer,
        due_at: input.due_at === undefined ? current.due_at : input.due_at,
        status,
      }),
    },
  );
  return toReviewView(payload);
}

export async function deleteReviewItem(reviewId: string, spaceId: string) {
  const current = await resolveReviewItem(reviewId, spaceId);
  const result = await request<null>(
    `/api/v1/review-items/${current.space_id}/${reviewId}`,
    { method: "DELETE" },
  );
  reviewItemsById.delete(scopedItemKey(spaceId, reviewId));
  return result;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [vault, spaces, providers, characters, sessions] = await Promise.all([
    getVaultStatus(),
    listSpaces(),
    listProviders(),
    listCharacters(),
    listSessions(),
  ]);

  return {
    vault,
    spaces,
    providers,
    characters,
    sessions,
  };
}
