import { request } from "./transport";
import { asMaterialIngestionResponse, encodeFilenameHeaderValue } from "./space-codec";

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
