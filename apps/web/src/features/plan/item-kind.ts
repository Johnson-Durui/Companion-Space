import t from "../../locales/zh-CN.json";

export const PLAN_ITEM_KIND = {
  lesson: "lesson",
  practice: "practice",
  exam: "mock",
} as const;

export function isLessonItem(kind: string): boolean {
  return kind === PLAN_ITEM_KIND.lesson;
}

export function isPracticeItem(kind: string): boolean {
  return kind === PLAN_ITEM_KIND.practice;
}

export function isExamItem(kind: string): boolean {
  return kind === PLAN_ITEM_KIND.exam;
}

export function isTimedPracticeItem(kind: string): boolean {
  return isPracticeItem(kind) || isExamItem(kind);
}

export function planItemKindLabel(kind: string): string {
  if (isLessonItem(kind)) return t.learner.planKinds.lesson;
  if (isPracticeItem(kind)) return t.learner.planKinds.practice;
  if (isExamItem(kind)) return t.learner.planKinds.practiceExam;
  return t.learner.planKinds.lesson;
}

export function planItemDisplayTitle(item: { kind: string; title: string }): string {
  if (isPracticeItem(item.kind) && (!item.title || item.title === "Practice")) return t.practice.practice;
  if (isExamItem(item.kind) && (!item.title || item.title === "Mock exam")) return t.practice.mock;
  return item.title;
}
