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

export type JourneyStepStatus = "done" | "active" | "todo" | "waiting";
export type JourneyNextStep = "materials" | "analysis" | "interview" | "placement" | "plan" | "learn";
export type JourneyStage =
  | "needs_materials"
  | "analyzing"
  | "interview"
  | "placement"
  | "plan_ready"
  | "learning"
  | "today_done"
  | "all_done"
  | "exam_passed";

export type CourseJourney = {
  course_id: string;
  steps: {
    materials: JourneyStepStatus;
    analysis: JourneyStepStatus;
    interview: JourneyStepStatus;
    placement: JourneyStepStatus;
    plan: JourneyStepStatus;
  };
  next_step: JourneyNextStep;
  stage: JourneyStage;
  has_materials: boolean;
  materials_ready: boolean;
  analysis_status: string | null;
  has_plan: boolean;
  exam_passed: boolean;
  all_done: boolean;
  kps_learned: number;
  kps_mastered: number;
  kps_total: number;
  deferred_count: number;
  lessons_completed: number;
};

export type PlanWhyEntry = {
  kp_id: string;
  kp_name: string;
  weight: number;
  mastery: number;
  highlighted: boolean;
  is_prereq: boolean;
};

export type TodayLessonItem = {
  id: string;
  title: string;
  est_minutes: number;
  status: string;
  kind?: string;
  lesson_id: string | null;
};

export type CourseDashboard = {
  course_id: string;
  has_plan?: boolean;
  due_review_count: number;
  today_lesson: TodayLessonItem | null;
  today_practice?: TodayLessonItem | null;
  today_lesson_why?: PlanWhyEntry[];
  lesson_index?: number | null;
  lesson_total?: number | null;
  remaining_days: number | null;
  exam_name?: string | null;
  exam_date?: string | null;
  target_score?: number | null;
  secured_score: number | null;
  score_scale: number | null;
  journey?: CourseJourney | null;
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
  created_at?: string | null;
  updated_at?: string | null;
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
