import type { paths } from "@companion-space/api-client/schema";
import { api, bodyOf } from "../../app/api";

type ProfileInput = paths["/api/v2/learner/profile"]["put"]["requestBody"]["content"]["application/json"];
type EnrollmentInput = paths["/api/v2/courses/{course_id}/enrollment"]["put"]["requestBody"]["content"]["application/json"];

export const learnerKeys = {
  profile: ["learner", "profile"] as const,
  enrollment: (courseId: string) => ["courses", courseId, "enrollment"] as const,
};

export async function getLearnerProfile() {
  return bodyOf(await api.GET("/api/v2/learner/profile"));
}

export async function saveLearnerProfile(body: ProfileInput) {
  return bodyOf(await api.PUT("/api/v2/learner/profile", { body }));
}

export async function getEnrollment(courseId: string) {
  return bodyOf(await api.GET("/api/v2/courses/{course_id}/enrollment", { params: { path: { course_id: courseId } } }));
}

export async function saveEnrollment(
  courseId: string,
  body: EnrollmentInput,
) {
  return bodyOf(await api.PUT("/api/v2/courses/{course_id}/enrollment", {
    params: { path: { course_id: courseId } }, body,
  }));
}

export type LearnerProfile = Awaited<ReturnType<typeof getLearnerProfile>>;
export type CourseEnrollment = Awaited<ReturnType<typeof getEnrollment>>;
