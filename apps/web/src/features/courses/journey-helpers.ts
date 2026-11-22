import t from "../../locales/zh-CN.json";
import { planItemDisplayTitle } from "../plan/item-kind";

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

export interface JourneySummaryInput {
  course_id: string;
  has_plan?: boolean;
  today_lesson?: {
    id: string;
    title: string;
    est_minutes: number;
    status: string;
    lesson_id?: string | null;
  } | null;
  today_practice?: {
    id: string;
    title: string;
    est_minutes: number;
    status: string;
    kind?: string;
  } | null;
  journey?: {
    stage: JourneyStage;
    next_step: string;
    analysis_status?: string | null;
    has_plan: boolean;
  } | null;
}

export interface CoursePrimaryAction {
  stage: JourneyStage;
  statusText: string;
  ctaLabel: string;
  to: string;
  requiresAi: boolean;
}

export function resolveCoursePrimaryAction(item: JourneySummaryInput): CoursePrimaryAction {
  const stage: JourneyStage = item.journey?.stage ?? (item.has_plan ? (item.today_lesson ? "learning" : "today_done") : "needs_materials");
  const labels = t.courseHub.stageLabels;
  const ctas = t.courseHub.stageCtas;

  if (stage === "needs_materials") {
    return {
      stage,
      statusText: labels.needs_materials,
      ctaLabel: ctas.needs_materials,
      to: `/courses/${item.course_id}/setup`,
      requiresAi: false,
    };
  }
  if (stage === "analyzing") {
    const running = item.journey?.analysis_status === "queued" || item.journey?.analysis_status === "running";
    return {
      stage,
      statusText: running ? labels.analyzing : labels.waiting_analysis,
      ctaLabel: ctas.analyzing,
      to: `/courses/${item.course_id}/setup`,
      requiresAi: false,
    };
  }
  if (stage === "interview") {
    return {
      stage,
      statusText: labels.interview,
      ctaLabel: ctas.interview,
      to: `/courses/${item.course_id}/setup`,
      requiresAi: false,
    };
  }
  if (stage === "placement") {
    return {
      stage,
      statusText: labels.placement,
      ctaLabel: ctas.placement,
      to: `/courses/${item.course_id}/setup`,
      requiresAi: false,
    };
  }
  if (stage === "plan_ready") {
    return {
      stage,
      statusText: labels.plan_ready,
      ctaLabel: ctas.plan_ready,
      to: `/courses/${item.course_id}/setup`,
      requiresAi: false,
    };
  }
  if (stage === "learning") {
    const lesson = item.today_lesson;
    if (lesson) {
      const resuming = lesson.status === "active" && Boolean(lesson.lesson_id);
      return {
        stage,
        statusText: labels.learning.replace("{title}", lesson.title),
        ctaLabel: resuming ? ctas.continue : ctas.learning,
        to: resuming && lesson.lesson_id ? `/lessons/${lesson.lesson_id}` : `/plan-items/${lesson.id}/lesson`,
        requiresAi: true,
      };
    }
    const practice = item.today_practice;
    if (practice) {
      return {
        stage,
        statusText: labels.learning.replace(
          "{title}",
          planItemDisplayTitle({ kind: practice.kind ?? "practice", title: practice.title }),
        ),
        ctaLabel: t.practice.open,
        to: `/plan-items/${practice.id}/practice`,
        requiresAi: false,
      };
    }
  }
  if (stage === "all_done") {
    return {
      stage,
      statusText: labels.all_done,
      ctaLabel: ctas.all_done,
      to: `/courses/${item.course_id}`,
      requiresAi: false,
    };
  }
  if (stage === "exam_passed") {
    return {
      stage,
      statusText: labels.exam_passed,
      ctaLabel: ctas.exam_passed,
      to: `/courses/${item.course_id}`,
      requiresAi: false,
    };
  }
  return {
    stage: "today_done",
    statusText: labels.today_done,
    ctaLabel: ctas.today_done,
    to: `/courses/${item.course_id}`,
    requiresAi: false,
  };
}
