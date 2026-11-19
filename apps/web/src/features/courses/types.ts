export type MaterialRole = "textbook" | "slides" | "notes" | "exam" | "exercise" | "syllabus";

export type CourseBrief = {
  page_count?: number;
  section_count?: number;
  knowledge_point_count?: number;
  item_count?: number;
  estimated_hours?: number;
  overview?: string;
  summary?: string;
  summary_support?: { supported: number; checked: number };
};

export type Course = { id: string; name: string; goal: string | null; brief: CourseBrief | null };

export type CourseDashboard = {
  course_id: string;
  due_review_count: number;
  today_lesson: { id: string; title: string; est_minutes: number; status: string; lesson_id: string | null } | null;
  remaining_days: number | null;
  secured_score: number | null;
  score_scale: number | null;
};

export type Material = {
  id: string;
  filename: string;
  title: string | null;
  role: MaterialRole;
  year: number | null;
  exam_name: string | null;
  has_answers: boolean | null;
  page_count: number;
  scanned_pages: number;
  parse_status: "pending" | "parsed" | "needs_vision" | "failed";
  error: string | null;
};

export type Job = {
  id: string;
  material_id: string | null;
  kind: string;
  stage: string | null;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  detail: string | null;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
};

export type AnalysisStart = {
  estimated_tokens: number;
  requires_confirmation: boolean;
  job: Job | null;
};

export type KpStats = {
  n_items: number;
  score_share: number;
  recency_weight: number;
  trend: string;
  types: Record<string, number>;
  novel_flags: string[];
  weight: number;
};

export type KnowledgePoint = {
  id: string;
  name: string;
  summary: string;
  importance: "core" | "important" | "peripheral";
  difficulty: 1 | 2 | 3;
  kind: string;
  formula: string | null;
  source_refs: Array<{ material_id: string; page_no: number }>;
  prerequisite_ids: string[];
  assumed: boolean;
  stats: KpStats | null;
};

export type CourseMap = {
  units: Array<{ id: string; title: string; knowledge_points: KnowledgePoint[] }>;
  brief: CourseBrief | null;
  warnings: string[];
  has_exams: boolean;
};

export type ExamItem = {
  id: string;
  no: string;
  type: string;
  stem: string;
  options: Record<string, string>;
  answer: string | null;
  solution: string | null;
  score: number | null;
  answer_status: string;
  page_refs: Array<{ material_id: string; page_no: number }>;
  kp_ids: string[];
};

export type MaterialPage = { markdown: string; source: string; quality: number; has_image: boolean };
