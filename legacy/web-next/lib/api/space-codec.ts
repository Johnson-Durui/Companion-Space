import type { IngestionJob, MaterialIngestionResponseWire, MaterialKind, MaterialRecord, ModelAssignment, ModelAssignmentWire, SpaceDetailResponseWire, StudySpaceDetail, StudySpaceSummary, StudySpaceWire } from "@/lib/types";
import { asProviderCapability, contractError, expectNullableString, expectRecord, expectString } from "./transport";

function expectMaterialKind(value: unknown, context: string): MaterialKind {
  const kind = expectString(value, context);
  if (kind !== "pdf" && kind !== "markdown" && kind !== "text" && kind !== "note") {
    throw contractError(`${context} 返回了不支持的资料类型`, value);
  }
  return kind;
}

export function asStudySpaceWire(payload: unknown, context: string): StudySpaceWire {
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

export function asMaterialWire(payload: unknown, context: string): SpaceDetailResponseWire["materials"][number] {
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

export function asIngestionJobWire(payload: unknown, context: string): SpaceDetailResponseWire["jobs"][number] {
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

export function asModelAssignmentWire(payload: unknown, context: string): ModelAssignmentWire {
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

export function toStudySpaceSummary(
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

export function toSpaceDetail(payload: SpaceDetailResponseWire): StudySpaceDetail {
  return {
    ...toStudySpaceSummary(payload.space, {
      materialCount: payload.materials.length,
      assignments: payload.assignments,
    }),
    materials: payload.materials.map(toMaterialRecord),
    jobs: payload.jobs.map(toIngestionJob),
  };
}

export function asMaterialIngestionResponse(payload: unknown, context: string): MaterialIngestionResponseWire {
  const record = expectRecord(payload, context);
  return {
    material: asMaterialWire(record.material, `${context}.material`),
    job: asIngestionJobWire(record.job, `${context}.job`),
  };
}

export function encodeFilenameHeaderValue(filename: string): string {
  return encodeURIComponent(filename);
}
