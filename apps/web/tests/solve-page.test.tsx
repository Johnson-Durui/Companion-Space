// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import SolvePage from "../src/features/solve/solve-page";
import type { SolveSessionDetail } from "../src/features/solve/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeSession(overrides: Partial<SolveSessionDetail> = {}): SolveSessionDetail {
  return {
    id: "solve-1",
    course_id: "course-1",
    source_kind: "text",
    stem: "求解方程 $2x + 16 = 100$。",
    has_image: false,
    image_url: null,
    verify_status: "verified",
    verify_reason: "Two independent solutions agree.",
    status: "active",
    mapped_kps: [
      { id: "kp-1", name: "一元一次方程", mastery_p: 0.5, mastery_status: "shaky", exam_weight: 0.25, exam_count: 3 },
    ],
    approach_prompt: "先说说你打算先移哪一项？",
    key_formula: "",
    hint_level: 0,
    max_hint_level: 2,
    hints: [],
    revealed: false,
    solved: false,
    steps: [],
    pitfalls: [],
    verified_answer: null,
    step_explanations: {},
    turns: [],
    mimic_items: [],
    created_at: "2026-11-23T10:00:00Z",
    updated_at: "2026-11-23T10:00:00Z",
    ...overrides,
  };
}

function renderSolve(initialEntry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/courses/:courseId/solve" element={<SolvePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("SolvePage dual-loop UI & honest verification", () => {
  it("shows honest amber notice when independent verification fails", async () => {
    const unverified = makeSession({
      verify_status: "unverified",
      steps: ["第一步：检查边界条件"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v2/courses/course-1/solve/solve-1")) {
          return Promise.resolve(new Response(JSON.stringify(unverified), { status: 200 }));
        }
        if (url.endsWith("/api/v2/courses/course-1/solve")) {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        if (url.endsWith("/api/v2/settings") || url.endsWith("/api/v2/characters")) {
          return Promise.resolve(new Response(JSON.stringify(url.endsWith("characters") ? [] : {}), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }),
    );

    const host = renderSolve("/courses/course-1/solve?session=solve-1");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="solve-unverified-notice"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="solve-steps-section"]')).not.toBeNull();
  });

  it("supports hint reveal, step breakdown, and verified mimic question submission", async () => {
    const initial = makeSession();
    const withHint = makeSession({
      hint_level: 1,
      hints: [{ level: 1, text: "先把常数项 16 移到等号右边。" }],
    });
    const withMimic = makeSession({
      revealed: true,
      steps: ["2x = 84", "x = 42"],
      verified_answer: "42",
      mimic_items: [
        {
          id: "ib-1",
          kp_id: "kp-1",
          type: "choice",
          difficulty: 2,
          stem: "求 2x = 30 的解",
          options: [
            { key: "A", text: "10" },
            { key: "B", text: "15" },
          ],
          result: null,
          answer: null,
          solution: null,
        },
      ],
    });
    const afterAnswer: SolveSessionDetail = {
      ...withMimic,
      mimic_items: [
        {
          ...withMimic.mimic_items[0]!,
          answer: "B",
          solution: "30 / 2 = 15",
          result: {
            item_id: "ib-1",
            verdict: "correct",
            learner_answer: "B",
            hint_level: 1,
            p_before: 0.5,
            p_after: 0.72,
            mastery_status: "shaky",
            answer: "B",
            solution: "30 / 2 = 15",
            submitted_at: "2026-11-23T10:05:00Z",
          },
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/v2/courses/course-1/solve/solve-1") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify(initial), { status: 200 }));
        }
        if (url.endsWith("/api/v2/courses/course-1/solve/solve-1/action") && method === "POST") {
          return Promise.resolve(new Response(JSON.stringify(withHint), { status: 200 }));
        }
        if (url.endsWith("/api/v2/courses/course-1/solve/solve-1/mimic") && method === "POST") {
          return Promise.resolve(new Response(JSON.stringify(withMimic), { status: 200 }));
        }
        if (url.endsWith("/api/v2/courses/course-1/solve/solve-1/mimic/ib-1/answer") && method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({ session: afterAnswer, result: afterAnswer.mimic_items[0]!.result }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/api/v2/characters")) {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }),
    );

    const host = renderSolve("/courses/course-1/solve?session=solve-1");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="solve-verify-badge"]')?.textContent).toContain("已完成独立验算");
    expect(host.querySelector('[data-testid="solve-steps-section"]')).toBeNull();

    // Click hint button
    const hintBtn = host.querySelector<HTMLButtonElement>('[data-testid="solve-hint-btn"]');
    expect(hintBtn).not.toBeNull();
    await act(async () => {
      hintBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(host.querySelector('[data-testid="solve-hints"]')?.textContent).toContain("常数项 16");

    // Generate mimic item
    const mimicBtn = host.querySelector<HTMLButtonElement>('[data-testid="solve-mimic-generate-btn"]');
    await act(async () => {
      mimicBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(host.querySelector('[data-testid="mimic-card-ib-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="solve-verified-answer"]')?.textContent).toContain("42");

    // Choose option B and submit
    const optionButtons = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="mimic-card-ib-1"] [role="radio"], [data-testid="mimic-card-ib-1"] button'));
    const optB = optionButtons.find((el) => el.textContent?.includes("15"));
    expect(optB).toBeDefined();
    act(() => {
      optB!.click();
    });

    const submitMimic = host.querySelector<HTMLButtonElement>('[data-testid="mimic-submit-ib-1"]');
    await act(async () => {
      submitMimic!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(host.querySelector('[data-testid="mimic-result-ib-1"]')?.textContent).toContain("50% → 72%");
  });
});
