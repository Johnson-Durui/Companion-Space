import type { MaterialRole } from "./types";

const examPattern = /(?:试卷|真题|考试|答案|exam|test|paper)/i;
const slidePattern = /(?:课件|幻灯|讲义|slide|ppt)/i;
const notePattern = /(?:笔记|notes?)/i;
const exercisePattern = /(?:习题|作业|练习|exercise|homework)/i;
const syllabusPattern = /(?:考纲|大纲|重点|syllabus)/i;
const yearPattern = /(?:19|20)\d{2}/;

export function inferMaterial(fileName: string): { role: MaterialRole; year?: number; has_answers?: boolean } {
  const base = fileName.replace(/\.[^.]+$/, "");
  const year = base.match(yearPattern)?.[0];
  if (syllabusPattern.test(base)) return { role: "syllabus" };
  if (exercisePattern.test(base)) return { role: "exercise", has_answers: /答案|解析|answer/i.test(base) };
  if (examPattern.test(base)) return { role: "exam", year: year ? Number(year) : undefined, has_answers: /答案|解析|answer/i.test(base) };
  if (slidePattern.test(base)) return { role: "slides" };
  if (notePattern.test(base)) return { role: "notes" };
  return { role: "textbook" };
}
