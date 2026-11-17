import { describe, expect, it } from "vitest";
import { inferMaterial } from "../src/features/courses/materials";

describe("material role inference", () => {
  it("extracts an exam year and answer hint from a filename", () => {
    expect(inferMaterial("2025年期末真题（含答案）.pdf")).toEqual({ role: "exam", year: 2025, has_answers: true });
  });

  it("keeps syllabus and exercises distinct from teaching materials", () => {
    expect(inferMaterial("复习考纲.docx")).toEqual({ role: "syllabus" });
    expect(inferMaterial("第三章练习题.md")).toEqual({ role: "exercise", has_answers: false });
  });

  it("uses textbook as the safe default", () => {
    expect(inferMaterial("概率入门.txt")).toEqual({ role: "textbook" });
  });
});
