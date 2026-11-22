import { describe, expect, it } from "vitest";
import { resolveLearnerNickname } from "../src/features/learner/nickname";
import { buildPlanWhySentence, masteryLabel, weightLabel } from "../src/features/plan/why-sentence";
import {
  coarseStageIndex,
  estimateRemainingMinutes,
  formatFileSize,
} from "../src/features/courses/analysis-stages";
import { resolveCoursePrimaryAction } from "../src/features/courses/journey-helpers";
import { deriveReadiness } from "../src/features/settings/readiness-logic";
import t from "../src/locales/zh-CN.json";

describe("U3 D3 nickname precedence rule", () => {
  it("uses learner profile nickname when set, ignoring tutor address_user_as", () => {
    expect(resolveLearnerNickname("小林", "同学")).toBe("小林");
    expect(resolveLearnerNickname("  阿明  ", "同学")).toBe("阿明");
  });

  it("falls back to tutor address_user_as only when profile nickname is empty", () => {
    expect(resolveLearnerNickname("", "小友")).toBe("小友");
    expect(resolveLearnerNickname("   ", "小友")).toBe("小友");
    expect(resolveLearnerNickname(null, "小友")).toBe("小友");
    expect(resolveLearnerNickname("", "")).toBe("");
  });
});

describe("U3 §7.1 plan reason sentence templates", () => {
  it("prioritizes teacher-highlighted knowledge points", () => {
    const sentence = buildPlanWhySentence({
      kp_id: "kp1",
      weight: 0.05,
      mastery: 0.8,
      highlighted: true,
    });
    expect(sentence).toBe(t.planView.whyTemplates.highlighted);
  });

  it("selects high-weight low-mastery, high-weight high-mastery, and prereq templates", () => {
    expect(
      buildPlanWhySentence({ kp_id: "a", weight: 0.3, mastery: 0.2 }),
    ).toBe(t.planView.whyTemplates.highWeightLowMastery);
    expect(
      buildPlanWhySentence({ kp_id: "b", weight: 0.3, mastery: 0.75 }),
    ).toBe(t.planView.whyTemplates.highWeightHighMastery);
    expect(
      buildPlanWhySentence({ kp_id: "c", weight: 0.05, mastery: 0.3, is_prereq: true }),
    ).toBe(t.planView.whyTemplates.prereqLowMastery);
    expect(weightLabel(0.25)).toBe(t.today.weightHigh);
    expect(masteryLabel(0.85)).toBe(t.today.masteryMastered);
  });
});

describe("U3 journey state & primary CTA routing (I12)", () => {
  it("never reports today_done when a course has no plan", () => {
    const action = resolveCoursePrimaryAction({
      course_id: "c1",
      has_plan: false,
      today_lesson: null,
      journey: {
        stage: "needs_materials",
        next_step: "materials",
        analysis_status: null,
        has_plan: false,
      },
    });
    expect(action.stage).not.toBe("today_done");
    expect(action.to).toBe("/courses/c1/setup");
  });

  it("routes learning lessons to lobby for new items and classroom for active lessons", () => {
    const fresh = resolveCoursePrimaryAction({
      course_id: "c1",
      has_plan: true,
      today_lesson: { id: "item-1", title: "极限", est_minutes: 20, status: "todo", lesson_id: null },
      journey: { stage: "learning", next_step: "learn", has_plan: true },
    });
    expect(fresh.to).toBe("/plan-items/item-1/lesson");
    expect(fresh.requiresAi).toBe(true);

    const resuming = resolveCoursePrimaryAction({
      course_id: "c1",
      has_plan: true,
      today_lesson: { id: "item-1", title: "极限", est_minutes: 20, status: "active", lesson_id: "les-9" },
      journey: { stage: "learning", next_step: "learn", has_plan: true },
    });
    expect(resuming.to).toBe("/lessons/les-9");
    expect(resuming.ctaLabel).toBe(t.courseHub.stageCtas.continue);
  });
});

describe("U3 coarse analysis stages, ETA, file size, and readiness", () => {
  it("maps all 10 backend stages monotonically to 4 coarse stages", () => {
    expect(coarseStageIndex("parse")).toBe(0);
    expect(coarseStageIndex("index")).toBe(0);
    expect(coarseStageIndex("kp_extract")).toBe(1);
    expect(coarseStageIndex("kp_reduce")).toBe(1);
    expect(coarseStageIndex("exam_extract")).toBe(2);
    expect(coarseStageIndex("exam_stats")).toBe(2);
    expect(coarseStageIndex("diag_pool")).toBe(3);
    expect(coarseStageIndex("brief")).toBe(3);
  });

  it("estimates remaining minutes when progress is meaningful and formats small files in KB", () => {
    const start = new Date(1_000_000).toISOString();
    expect(estimateRemainingMinutes(0.5, start, 1_120_000)).toBe(2);
    expect(estimateRemainingMinutes(0.05, start, 1_120_000)).toBeNull();
    expect(formatFileSize(12_000)).toBe("12 KB");
    expect(formatFileSize(2_500_000)).toBe("2.4 MB");
  });

  it("derives 5 readiness flags with checker falling back to analysis", () => {
    const empty = deriveReadiness({}, false);
    expect(empty.readyForLessons).toBe(false);
    expect(empty.canCheck).toBe(false);

    const ready = deriveReadiness({ live: { model: "a" }, analysis: { model: "b" }, vision: { model: "c" } }, true);
    expect(ready.readyForLessons).toBe(true);
    expect(ready.canCheck).toBe(true);
    expect(ready.canSeeImages).toBe(true);
    expect(ready.canUseVoice).toBe(true);
  });
});
