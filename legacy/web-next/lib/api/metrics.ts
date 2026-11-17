import type { LocalMetricSignalInput, LocalMetricsSummary } from "@/lib/types";
import { expectNullableNumber, expectNumber, expectRecord, request } from "./transport";

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
