// @vitest-environment happy-dom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MasteryBar,
  MasteryGrid,
  PrereqChain,
  ScoreBar,
  ScoreRing,
  SegmentProgress,
  StudyCalendar,
  WeeklyMinutes,
  WeightBar,
  computeStreakDays,
} from "../src/ui/charts";
import { PlanDiffList, summarizePlanDiff } from "../src/features/plan/plan-diff";
import { formatNextReviewDue, ReviewCardRunner } from "../src/features/review/review-card-runner";
import * as reviewApi from "../src/features/review/api";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function renderNode(node: ReactNode) {
  act(() => {
    root.render(node);
  });
}

describe("U5 SVG charts & accessibility", () => {
  it("renders MasteryGrid grouped by unit with clickable tiles and status shapes", () => {
    const onSelect = vi.fn();
    renderNode(
      <MasteryGrid
        points={[
          { id: "kp1", name: "极限定义", unitId: "u1", unitTitle: "第一章", probability: 0.9, status: "mastered", weight: 0.4 },
          { id: "kp2", name: "连续性", unitId: "u1", unitTitle: "第一章", probability: 0.3, status: "shaky", weight: 0.2 },
        ]}
        statusLabels={{ unseen: "未学", learning: "在学", shaky: "不稳", mastered: "已掌握" }}
        ungroupedLabel="其他"
        highWeightLabel="高频考点"
        emptyLabel="暂无"
        onSelectPoint={onSelect}
      />,
    );
    expect(container.textContent).toContain("第一章");
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="mastery-tile-kp1"]');
    expect(tile).not.toBeNull();
    act(() => {
      tile!.click();
    });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "kp1" }));
  });

  it("renders WeightBar, MasteryBar, ScoreBar, ScoreRing, SegmentProgress, and PrereqChain with text equivalents", () => {
    const onPick = vi.fn();
    renderNode(
      <div>
        <WeightBar weight={0.5} label="考试权重" valueText="高频" />
        <MasteryBar probability={0.85} status="mastered" label="当前掌握" valueText="已掌握" />
        <ScoreBar secured={72.5} scale={100} target={85} label="保分" gapLabel="距目标 {target} 分还差 {gap} 分" />
        <ScoreRing score={8} maxScore={10} label="得分" />
        <SegmentProgress current={2} total={4} label="要点" />
        <PrereqChain
          prereqs={[{ id: "p0", name: "集合" }]}
          current={{ id: "p1", name: "函数" }}
          dependents={[{ id: "p2", name: "极限" }]}
          prereqLabel="先学"
          dependentLabel="后续"
          onSelect={onPick}
        />
      </div>,
    );
    expect(container.textContent).toContain("距目标 85 分还差 12.5 分");
    expect(container.textContent).toContain("8/10");
    const segSvg = container.querySelector('svg[role="img"][aria-label*="要点 2 / 4"]');
    expect(segSvg).not.toBeNull();
    const prereqBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "集合",
    );
    expect(prereqBtn).toBeDefined();
    act(() => {
      prereqBtn!.click();
    });
    expect(onPick).toHaveBeenCalledWith("p0");
  });

  it("computes consecutive study streak and handles empty states for StudyCalendar & WeeklyMinutes", () => {
    const today = new Date("2026-11-22T12:00:00Z");
    const streak = computeStreakDays(
      [
        { day: "2026-11-20", evidence_count: 2 },
        { day: "2026-11-21", evidence_count: 1 },
        { day: "2026-11-22", evidence_count: 4 },
      ],
      today,
    );
    expect(streak).toBe(3);

    renderNode(
      <div>
        <StudyCalendar
          trend={[]}
          label="日历"
          streakLabel="连续 {days} 天"
          activeDaysLabel="共 {count} 天"
          emptyLabel="尚无学习记录"
          today={today}
        />
        <WeeklyMinutes weeks={[]} label="时长" unitLabel="分钟" emptyLabel="尚无时长" />
      </div>,
    );
    expect(container.textContent).toContain("尚无学习记录");
    expect(container.textContent).toContain("尚无时长");
  });
});

describe("U5 Plan diff & Review I14 feedback", () => {
  it("formats plan diff categories accurately", () => {
    const diff = {
      moved_earlier: [{ title: "连续性", kind: "lesson", kp_ids: ["kp2"] }],
      moved_later: [{ title: "极限定义", kind: "lesson", kp_ids: ["kp1"] }],
      added: [{ title: "Practice", kind: "practice", kp_ids: ["kp1"] }],
      deferred: [{ kp_id: "kp4", kp_name: "中值定理" }],
    };
    const summary = summarizePlanDiff(diff);
    expect(summary).toContain("连续性");
    expect(summary).toContain("专项练习");
    expect(summary).toContain("中值定理");

    renderNode(<PlanDiffList diff={diff} />);
    expect(container.querySelector('[data-testid="plan-diff-list"]')).not.toBeNull();
    expect(container.textContent).toContain("提前了");
    expect(container.textContent).toContain("延后了");
    expect(container.textContent).toContain("新排进来");
    expect(container.textContent).toContain("暂缓");
  });

  it("formats next review due dates cleanly", () => {
    const now = new Date("2026-11-22T10:00:00Z");
    expect(formatNextReviewDue("2026-11-22T12:00:00Z", now)).toContain("今天");
    expect(formatNextReviewDue("2026-11-23T10:00:00Z", now)).toContain("明天");
    expect(formatNextReviewDue("2026-11-26T10:00:00Z", now)).toContain("4 天后");
  });

  it("I14: ReviewCardRunner pauses in feedback state until explicit Next click", async () => {
    const onAdvance = vi.fn();
    vi.spyOn(reviewApi, "answerCard").mockResolvedValue({
      card_id: "c1",
      verdict: "incorrect",
      rating: "again",
      answer: "B",
      solution: "因为 2 + 2 = 4。",
      due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      state: "active",
      kp_id: "kp1",
      kp_name: "基础加法",
      before_mastery: { probability: 0.5, status: "learning" },
      mastery: { probability: 0.32, status: "shaky" },
    });

    const qc = new QueryClient();
    renderNode(
      <QueryClientProvider client={qc}>
        <ReviewCardRunner
          card={{
            id: "c1",
            kp_id: "kp1",
            kp_name: "基础加法",
            kind: "item",
            front: "2 + 2 = ?",
            due_at: new Date().toISOString(),
            item: { type: "choice", stem: "2 + 2 = ?", options: { A: "3", B: "4" } },
          }}
          onAdvance={onAdvance}
        />
      </QueryClientProvider>,
    );

    const optA = container.querySelector<HTMLButtonElement>('[data-choice-key="A"]');
    expect(optA).not.toBeNull();
    act(() => {
      optA!.click();
    });
    const submitBtn = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("提交答案"),
    );
    expect(submitBtn).toBeDefined();
    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const feedback = container.querySelector('[data-testid="review-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback!.textContent).toContain("因为 2 + 2 = 4");
    expect(feedback!.textContent).toContain("3 天后");
    expect(container.querySelector('[data-testid="review-mastery-delta"]')?.textContent).toContain("50%");
    expect(onAdvance).not.toHaveBeenCalled();

    const nextBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-next-btn"]');
    expect(nextBtn).not.toBeNull();
    act(() => {
      nextBtn!.click();
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});
