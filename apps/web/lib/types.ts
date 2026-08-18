export type ProviderCapability = "chat_llm" | "analysis_llm" | "embedding" | "stt" | "tts";

export type SessionState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error"
  | "closed";

export type TtsPlaybackPolicy = "browser-compat" | "server-neural" | "server";

export type MaterialKindWire = "pdf" | "markdown" | "text" | "note";
export type MemoryStatus = "candidate" | "confirmed" | "discarded";
export type ReviewStatus = "pending" | "completed";
export type LearningArtifactsStatus = "idle" | "pending" | "running" | "ready" | "error";
export type TurnRole = "user" | "assistant";
export const COMPANION_EMOTIONS = [
  "neutral",
  "warm",
  "cheerful",
  "curious",
  "focused",
  "playful",
  "concerned",
] as const;
export type CompanionEmotion = (typeof COMPANION_EMOTIONS)[number];

export function isCompanionEmotion(value: unknown): value is CompanionEmotion {
  return typeof value === "string" && COMPANION_EMOTIONS.some((emotion) => emotion === value);
}
export type BoardActionKind = "mermaid" | "markdown" | "highlight";

export interface Citation {
  chunk_id: string;
  material_id: string;
  title: string;
  locator: string;
  excerpt: string | null;
}

export interface UsageRecord {
  input_tokens: number;
  output_tokens: number;
  audio_input_bytes: number;
  audio_output_bytes: number;
}

interface BoardActionBase {
  kind: BoardActionKind;
  content: string;
  target?: string | null;
}

export interface MermaidBoardAction extends BoardActionBase {
  kind: "mermaid";
}

export interface MarkdownBoardAction extends BoardActionBase {
  kind: "markdown";
}

export interface HighlightBoardAction extends BoardActionBase {
  kind: "highlight";
}

export type BoardAction =
  | MermaidBoardAction
  | MarkdownBoardAction
  | HighlightBoardAction;

export interface LessonStep {
  board: BoardAction;
  caption: string;
  narration: string;
}

export interface LessonScript {
  title: string;
  steps: LessonStep[];
}

export interface StudySpaceWire {
  id: string;
  name: string;
  topic: string;
  goal: string;
  default_character_pack_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialWire {
  id: string;
  space_id: string;
  title: string;
  kind: MaterialKindWire;
  filename: string;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface IngestionJobWire {
  id: string;
  space_id: string;
  material_id: string;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export type AvatarFraming = "full_body" | "portrait";
export type AvatarStageBackground = "neutral" | "study" | "midnight";

export interface CharacterRecipe {
  avatar_model: string;
  avatar_framing: AvatarFraming;
  stage_background: AvatarStageBackground;
  base_model: string;
  face_style: string;
  hairstyle: string;
  outfit: string;
  accessories: string[];
  palette: Record<string, string>;
  personality: string;
  warmth: number;
  initiative: number;
  humor: number;
  challenge: number;
  relationship_role: string;
  voice_provider: string;
  voice_model: string;
  voice_id: string;
  speaking_rate: number;
  motions: Record<string, string>;
}

export type CharacterPreviewState = "idle" | "listening" | "thinking" | "speaking";
export type CharacterVisibility = "private" | "shared" | "template";
export type LicensedAvatarRuntimeFormat = "live2d" | "spine";

export interface CharacterAssetManifest extends Record<string, unknown> {
  asset_paths?: unknown;
  entrypoint?: unknown;
  format?: unknown;
  model_path?: unknown;
  render_mode?: unknown;
  sha256?: unknown;
}

export interface CharacterPackWire {
  id: string;
  name: string;
  description: string;
  recipe: CharacterRecipe;
  asset_manifest: CharacterAssetManifest;
  created_at: string;
  updated_at: string;
}

export interface ProviderConnectionWire {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  capabilities: ProviderCapability[];
  created_at: string;
  updated_at: string;
}

export interface ProviderRegistryEntryWire {
  provider: string;
  capabilities: ProviderCapability[];
  supports_custom_base_url: boolean;
  requires_api_key: boolean;
  default_models: string[];
}

export interface ModelAssignmentWire {
  id: string;
  space_id: string;
  capability: ProviderCapability;
  provider_connection_id: string;
  model_name: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRecordWire {
  id: string;
  space_id: string;
  character_pack_id: string | null;
  state: SessionState;
  summary: string;
  generated_summary?: string | null;
  notes?: string | null;
  artifacts_status?: LearningArtifactsStatus | null;
  artifacts_error?: string | null;
  artifacts_updated_at?: string | null;
  tts_connection_id?: string | null;
  tts_model_name?: string | null;
  tts_playback_policy?: TtsPlaybackPolicy | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface CompanionTurn {
  id: string;
  session_id: string;
  space_id: string;
  role: TurnRole;
  display_text: string;
  spoken_text: string;
  emotion: CompanionEmotion;
  citations: Citation[];
  board_actions?: BoardAction[];
  suggested_actions: string[];
  usage: UsageRecord;
  created_at: string;
}

export interface MemoryItemWire {
  id: string;
  space_id: string;
  content: string;
  status: MemoryStatus;
  sensitive: boolean;
  source_session_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewItemWire {
  id: string;
  space_id: string;
  prompt: string;
  answer: string;
  due_at: string | null;
  status: ReviewStatus;
  source_session_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RealtimeEventWire {
  type: string;
  session_id: string;
  state: SessionState | null;
  payload: Record<string, unknown>;
}

export interface BoardUpdatePayload {
  board_actions: BoardAction[];
  turn_id?: string | null;
}

export interface DemoReadyPayload {
  session_id: string;
  topic: string;
  script: LessonScript;
  citations: Citation[];
  used_space_materials: boolean;
}

export interface VaultStatusWire {
  initialized: boolean;
  unlocked: boolean;
}

export type VaultStatus = VaultStatusWire;

export interface NeuralTtsSidecarStatus {
  enabled: boolean;
  ready: boolean;
  connection_id: string;
  model: string | null;
  new_spaces_use_neural: boolean;
  how_to_switch: string;
}

export interface VaultUnlockResponse {
  initialized: boolean;
  unlocked: boolean;
  owner_token: string | null;
}

export interface OwnerPreferencesWire {
  adult_relationships_enabled: boolean;
  adult_age_confirmed_at: string | null;
}

export interface OwnerPreferences {
  adult_relationships_enabled: boolean;
  adult_age_confirmed_at: string | null;
}

export interface MobilePairingChallenge {
  challenge_id: string;
  code: string;
  expires_at: string;
  attempts_allowed: number;
}

export interface MobileDevice {
  id: string;
  name: string;
  refresh_expires_at: string;
  created_at: string;
  last_seen_at: string;
}

export interface LocalMetricNumericSummary {
  count: number;
  max?: number | null;
  min?: number | null;
  p50: number | null;
}

export type LocalMetricSignalEvent =
  | "interrupt_latency_ms"
  | "first_audio_latency_ms"
  | "avatar_fps"
  | "soak_memory_delta_mb"
  | "audio_residue_scan"
  | "text_fallback_used";

export type LocalTextFallbackReason =
  | "realtime_url_missing"
  | "owner_token_missing"
  | "realtime_url_invalid"
  | "realtime_disconnected"
  | "microphone_denied"
  | "realtime_connect_failed"
  | "realtime_server_error";

export type LocalMetricSignalInput =
  | {
      event: "interrupt_latency_ms" | "first_audio_latency_ms" | "avatar_fps" | "soak_memory_delta_mb";
      session_id: string;
      value: number;
    }
  | {
      event: "audio_residue_scan";
      session_id: string;
      residue_found: boolean;
    }
  | {
      event: "text_fallback_used";
      session_id: string;
      code: LocalTextFallbackReason;
    };

export interface LocalMetricsSummary {
  activation: {
    vault_initialized: number;
    provider_connected_or_mock: number;
    space_created: number;
    material_ready: number;
    character_saved: number;
    session_ended: number;
    recap_viewed: number;
  };
  reliability: {
    api_error: number;
    ws_error: number;
    ingestion_failed: number;
    model_timeout: number;
    text_fallback_used: number;
    illegal_state_transition: number;
  };
  quality: {
    citation_verified: { matched: number; total: number };
    recap_edited: number;
    memory_candidate_confirmed: number;
    memory_candidate_rejected: number;
  };
  performance: {
    interrupt_latency_ms: LocalMetricNumericSummary;
    first_audio_latency_ms: LocalMetricNumericSummary;
    avatar_fps: LocalMetricNumericSummary;
    soak_memory_delta_mb: LocalMetricNumericSummary;
    audio_residue_scan: { clean: number; residue_found: number };
  };
  rates: {
    api_error_rate: number | null;
    ws_error_rate: number | null;
    ingestion_failure_rate: number | null;
    model_timeout_rate: number | null;
    text_fallback_rate: number | null;
    citation_accuracy: number | null;
    recap_edit_rate: number | null;
    memory_confirmation_rate: number | null;
  };
}

export interface SpaceDetailResponseWire {
  space: StudySpaceWire;
  materials: MaterialWire[];
  jobs: IngestionJobWire[];
  assignments: ModelAssignmentWire[];
}

export interface MaterialIngestionResponseWire {
  material: MaterialWire;
  job: IngestionJobWire;
}

export interface SessionTranscriptResponseWire {
  session: SessionRecordWire;
  turns: CompanionTurn[];
  memory_candidates?: MemoryItemWire[];
  review_items?: ReviewItemWire[];
}

export interface ProviderTestResponseWire {
  connection_id: string;
  provider: string;
  ok: boolean;
  mode: "local" | "remote";
  capabilities: ProviderCapability[];
  models: string[];
  latency_ms: number | null;
  message: string | null;
}

export interface ProviderModelsResponseWire {
  models: string[];
}

export interface RealtimeTicketResponseWire {
  ticket: string;
  expires_at: string;
}

export interface SessionDemoResponseWire {
  session_id: string;
  topic: string;
  script: LessonScript;
  citations: Citation[];
  used_space_materials: boolean;
}

export interface SessionDemoRequestInput {
  topic: string;
}

/*
 * Transitional component view models. Network responses are decoded through the
 * exact `*Wire` contracts above; these aliases can be removed as the existing
 * panels migrate to domain field names.
 */
export type MaterialKind = MaterialKindWire;
export type ProviderRegistryEntry = ProviderRegistryEntryWire;
export type ProviderModelsResponse = ProviderModelsResponseWire;
export type ProviderTestResult = ProviderTestResponseWire;

export interface ProviderConnection extends ProviderConnectionWire {
  default_model?: string | null;
  status?: "ready" | "degraded" | "error" | "unknown";
  last_tested_at?: string | null;
}

export interface ModelAssignment {
  capability: ProviderCapability;
  connection_id?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: "ready" | "missing" | "error" | "unknown";
}

export interface StudySpaceSummary {
  id: string;
  title: string;
  theme?: string | null;
  goal?: string | null;
  default_character_id?: string | null;
  material_count?: number;
  session_count?: number;
  knowledge_status?: string | null;
  model_assignments?: ModelAssignment[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MaterialRecord {
  id: string;
  title: string;
  filename?: string | null;
  kind: MaterialKind;
  chunk_count?: number | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface IngestionJob {
  id: string;
  status: string;
  material_id: string;
  created_at: string;
  updated_at: string;
  detail: string | null;
}

export interface StudySpaceDetail extends StudySpaceSummary {
  materials: MaterialRecord[];
  jobs: IngestionJob[];
}

export interface LegacyKnowledgeCandidate {
  document_id: string;
  filename: string;
  title: string;
  source_type: string;
  chunk_count: number;
  importable: boolean;
  issue: string | null;
}

export interface LegacyKnowledgeImportResult {
  document_id: string;
  space_id: string;
  material_id: string;
  filename: string;
  title: string;
  kind: MaterialKind;
  chunk_count: number;
  status: string;
  already_imported: boolean;
}

export interface CharacterPackSummary {
  id: string;
  name: string;
  archetype?: string | null;
  style?: string | null;
  visibility?: CharacterVisibility;
  updated_at?: string | null;
}

export interface CharacterPackDetail extends CharacterPackSummary {
  description?: string | null;
  recipe: CharacterRecipe;
  license_summary?: string | null;
  asset_manifest?: CharacterAssetManifest | null;
}

export interface CharacterWorkshopDocument {
  schema_version: "character_recipe_v1";
  exported_at: string;
  name: string;
  description: string;
  recipe: CharacterRecipe;
  preview_state?: CharacterPreviewState | null;
  voice_preview_text?: string | null;
}

export interface MemoryItem {
  id: string;
  space_id: string;
  content: string;
  confirmed: boolean;
  sensitivity?: "normal" | "sensitive";
  source_session_id?: string | null;
  created_at?: string | null;
}

export interface ReviewItem {
  id: string;
  space_id: string;
  prompt: string;
  answer?: string | null;
  due_at?: string | null;
  status?: string | null;
  source_session_id?: string | null;
  created_at?: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  space_id: string;
  character_pack_id: string | null;
  space_title?: string | null;
  character_name?: string | null;
  state: SessionState;
  turn_count?: number;
  tts_connection_id?: string | null;
  tts_model_name?: string | null;
  tts_playback_policy?: TtsPlaybackPolicy | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SessionDetail extends SessionSummary {
  transcript: CompanionTurn[];
  summary?: string | null;
  generated_summary?: string | null;
  notes?: string | null;
  artifacts_status?: LearningArtifactsStatus | null;
  artifacts_error?: string | null;
  artifacts_updated_at?: string | null;
  memory_candidates?: MemoryItem[];
  review_items?: ReviewItem[];
}

export interface DashboardSnapshot {
  vault: VaultStatus | null;
  spaces: StudySpaceSummary[];
  providers: ProviderConnection[];
  characters: CharacterPackSummary[];
  sessions: SessionSummary[];
}
