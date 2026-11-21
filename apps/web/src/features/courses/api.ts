import { browserApiFetch } from "@companion-space/api-client";
import { ApiError, publicMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";
import type { AnalysisStart, Course, CourseDashboard, CourseMap, ExamItem, Job, Material, MaterialPage, MaterialRole } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await browserApiFetch(path, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(publicMessage(body) ?? t.common.error, response.status);
  return body as T;
}

export const courseKeys = {
  all: ["courses"] as const,
  one: (id: string) => ["courses", id] as const,
  materials: (id: string) => ["courses", id, "materials"] as const,
  analysis: (id: string) => ["courses", id, "analysis"] as const,
  map: (id: string) => ["courses", id, "map"] as const,
  exams: (id: string, kpId: string) => ["courses", id, "exam-items", kpId] as const,
  unmappedExams: (id: string) => ["courses", id, "exam-items", "unmapped"] as const,
  page: (materialId: string, pageNo: number) => ["materials", materialId, "pages", pageNo] as const,
};

export const listCourses = () => request<Course[]>("/api/v2/courses");
export const listCourseDashboard = () => request<CourseDashboard[]>("/api/v2/courses/dashboard");
export const getCourse = (id: string) => request<Course>(`/api/v2/courses/${id}`);
export const createCourse = (body: { name: string; goal?: string }) => request<Course>("/api/v2/courses", { method: "POST", body: JSON.stringify(body) });
export const listMaterials = (id: string) => request<Material[]>(`/api/v2/courses/${id}/materials`);

export function uploadMaterials(id: string, files: File[], metadata: Array<{ role: MaterialRole; year?: number; exam_name?: string; has_answers?: boolean }>) {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  form.append("metadata", JSON.stringify(metadata));
  return request<Material[]>(`/api/v2/courses/${id}/materials`, { method: "POST", body: form });
}

export const pasteMaterial = (id: string, body: { title: string; content: string; role: MaterialRole }) =>
  request<Material>(`/api/v2/courses/${id}/materials/note`, { method: "POST", body: JSON.stringify(body) });

export const updateMaterial = (courseId: string, materialId: string, body: Partial<Pick<Material, "role" | "year" | "exam_name" | "has_answers">>) =>
  request<Material>(`/api/v2/courses/${courseId}/materials/${materialId}`, { method: "PATCH", body: JSON.stringify(body) });
export const startAnalysis = (id: string, confirmed = false) => request<AnalysisStart>(`/api/v2/courses/${id}/analysis/start`, { method: "POST", body: JSON.stringify({ confirmed }) });
export const getAnalysis = (id: string) => request<Job | null>(`/api/v2/courses/${id}/analysis/status`);
export const retryAnalysis = (id: string, stage: string) => request<Job>(`/api/v2/courses/${id}/analysis/retry`, { method: "POST", body: JSON.stringify({ stage }) });
export const getCourseMap = (id: string) => request<CourseMap>(`/api/v2/courses/${id}/map`);
export const updateKnowledgePoint = (courseId: string, kpId: string, body: { name?: string; importance?: string; prerequisite_ids?: string[]; merge_into?: string; deleted?: boolean }) =>
  request<KnowledgePointUpdate>(`/api/v2/courses/${courseId}/kps/${kpId}`, { method: "PATCH", body: JSON.stringify(body) });
type KnowledgePointUpdate = { map?: CourseMap } | CourseMap;
export const listExamItems = (id: string, kpId: string) => request<ExamItem[]>(`/api/v2/courses/${id}/exam-items?kp_id=${encodeURIComponent(kpId)}`);
export const listUnmappedExamItems = (id: string) => request<ExamItem[]>(`/api/v2/courses/${id}/exam-items?unmapped=true`);
export const getMaterialPage = (materialId: string, pageNo: number) => request<MaterialPage>(`/api/v2/materials/${materialId}/pages/${pageNo}`);
export const materialPageImage = (materialId: string, pageNo: number) => `/api/v2/materials/${materialId}/pages/${pageNo}/image`;
