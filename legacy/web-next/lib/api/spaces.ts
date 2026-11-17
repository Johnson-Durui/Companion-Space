import { apiClient, apiData, ApiError, expectArray, expectRecord, request } from "./transport";
import type { ProviderCapability, StudySpaceWire } from "@/lib/types";
import { asIngestionJobWire, asMaterialWire, asModelAssignmentWire, asStudySpaceWire, toSpaceDetail, toStudySpaceSummary } from "./space-codec";

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

function toSpaceCreatePayload(
  input: StudySpaceCreateInput | LegacyStudySpaceCreateInput,
): Required<StudySpaceCreateInput> {
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

export async function loadSpacesWire(): Promise<StudySpaceWire[]> {
  const payload = apiData(await apiClient().GET("/api/v1/spaces"), "空间列表读取失败");
  return expectArray<unknown>(payload, "空间列表接口").map((item, index) =>
    asStudySpaceWire(item, `空间列表接口[${index}]`)
  );
}

export async function listSpaces() {
  return (await loadSpacesWire()).map((space) => toStudySpaceSummary(space));
}

export async function createSpace(
  input: StudySpaceCreateInput | LegacyStudySpaceCreateInput,
) {
  const payload = apiData(await apiClient().POST("/api/v1/spaces", { body: toSpaceCreatePayload(input) }), "创建空间失败");
  return toStudySpaceSummary(asStudySpaceWire(payload, "空间接口"));
}

export async function getSpace(spaceId: string) {
  const payload = apiData(await apiClient().GET("/api/v1/spaces/{space_id}", { params: { path: { space_id: spaceId } } }), "读取空间失败");
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
