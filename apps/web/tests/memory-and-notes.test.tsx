// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseMemoryCard } from "../src/features/memory/memory-cards";
import NotesPage from "../src/features/notes/notes-page";
import ReaderPage from "../src/features/notes/reader-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement, initialEntry: string, routePath: string) {
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
            <Route path={routePath} element={element} />
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

describe("Phase 3 & Phase 4 UI workflows", () => {
  it("renders CourseMemoryCard with evidence links and lets learner forget a memory", async () => {
    const fact = {
      id: "mem-1",
      course_id: "course-1",
      kp_id: "kp-1",
      kp_name: "第一重要极限",
      kind: "mistake_habit",
      statement: "做极限题容易忘记检查弧度制。",
      evidence_refs: [{ kind: "solve", id: "solve-1", href: "/courses/course-1/solve?session=solve-1" }],
      status: "active",
      user_edited: false,
      created_at: "2026-11-23T10:00:00Z",
      updated_at: "2026-11-23T10:00:00Z",
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/v2/courses/course-1/memories") && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify([fact]), { status: 200 }));
      }
      if (url.endsWith("/api/v2/courses/course-1/memories/mem-1") && method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ ...fact, status: "dismissed" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = mount(<CourseMemoryCard courseId="course-1" />, "/courses/course-1/progress", "/courses/:courseId/progress");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const row = host.querySelector('[data-testid="memory-fact-mem-1"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("弧度制");
    expect(row?.querySelector('a[href="/courses/course-1/solve?session=solve-1"]')).not.toBeNull();

    const forgetBtn = Array.from(row!.querySelectorAll("button")).find((btn) => btn.textContent?.includes("忘掉"));
    expect(forgetBtn).toBeDefined();
    await act(async () => {
      forgetBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="memory-fact-mem-1"]')).toBeNull();
  });

  it("renders NotesPage blocks, requests read-only Diff suggestions, and inserts upon acceptance", async () => {
    const initialNote = {
      id: "note-1",
      course_id: "course-1",
      title: "第一章笔记",
      kp_id: null,
      kp_name: "",
      blocks: [
        {
          id: "blk-1",
          ord: 0,
          block_type: "text",
          title: "核心定义",
          content: "极限描述函数在一点附近的变化趋势。",
          source_ref: { kind: "material_page", material_id: "mat-1", material_title: "教材", page_no: 1 },
          created_at: "2026-11-23T10:00:00Z",
          updated_at: "2026-11-23T10:00:00Z",
        },
      ],
      created_at: "2026-11-23T10:00:00Z",
      updated_at: "2026-11-23T10:00:00Z",
    };
    const updatedNote = {
      ...initialNote,
      blocks: [
        ...initialNote.blocks,
        {
          id: "blk-2",
          ord: 1,
          block_type: "callout",
          title: "易错点",
          content: "极限存在不要求该点有定义。",
          source_ref: null,
          created_at: "2026-11-23T10:05:00Z",
          updated_at: "2026-11-23T10:05:00Z",
        },
      ],
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/v2/courses/course-1/notes") && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ id: "note-1", course_id: "course-1", title: "第一章笔记", kp_id: null, kp_name: "", block_count: 1, created_at: "2026-11-23T10:00:00Z", updated_at: "2026-11-23T10:00:00Z" }]),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/api/v2/courses/course-1/notes/note-1") && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify(initialNote), { status: 200 }));
      }
      if (url.endsWith("/api/v2/courses/course-1/notes/note-1/suggest") && method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "sug-1",
                reason: "补充极限存在与函数定义无关的易错点",
                block_type: "callout",
                title: "易错点",
                content: "极限存在不要求该点有定义。",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/api/v2/courses/course-1/notes/note-1/blocks") && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify(updatedNote), { status: 201 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = mount(<NotesPage />, "/courses/course-1/notes", "/courses/:courseId/notes");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="note-block-blk-1"]')).not.toBeNull();
    const suggestBtn = host.querySelector<HTMLButtonElement>('[data-testid="note-suggest-btn"]');
    await act(async () => {
      suggestBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="note-suggestions-panel"]')).not.toBeNull();
    const acceptBtn = host.querySelector<HTMLButtonElement>('[data-testid="accept-suggestion-sug-1"]');
    await act(async () => {
      acceptBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="note-block-blk-2"]')).not.toBeNull();
  });

  it("renders ReaderPage with KP exam badges, asks about a passage, and saves to notes", async () => {
    const savedCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/v2/courses/course-1/materials/mat-1/reader")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                course_id: "course-1",
                material_id: "mat-1",
                title: "高等数学上册",
                role: "textbook",
                parse_status: "parsed",
                page_count: 2,
                sections: [{ id: "s1", title: "第一章 极限", page_start: 1, page_end: 2 }],
                pages: [{ page_no: 1, has_image: false, kps: [] }],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/api/v2/courses/course-1/materials/mat-1/pages/1/reader")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                course_id: "course-1",
                material_id: "mat-1",
                material_title: "高等数学上册",
                page_no: 1,
                total_pages: 2,
                section_title: "第一章 极限",
                markdown: "第一重要极限是微积分的重要基础。",
                has_image: false,
                image_url: null,
                kps: [
                  {
                    id: "kp-1",
                    name: "第一重要极限",
                    mastery_p: 0.4,
                    mastery_status: "shaky",
                    exam_count: 5,
                    exam_weight: 0.2,
                  },
                ],
                quick_quiz: null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/api/v2/courses/course-1/materials/mat-1/pages/1/ask") && method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                explanation: "等价无穷小替换要求极限点在 0 附近。",
                key_takeaway: "0 附近可用等价无穷小",
                suggested_block: {
                  block_type: "callout",
                  title: "第一重要极限",
                  content: "弧度制下 sin(x)/x → 1",
                  source_ref: { kind: "material_page", material_id: "mat-1", page_no: 1 },
                },
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/api/v2/courses/course-1/notes/quick/blocks") && method === "POST") {
          savedCalls.push(url);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "note-q",
                course_id: "course-1",
                title: "随堂精选笔记",
                kp_id: null,
                kp_name: "",
                blocks: [],
                created_at: "2026-11-23T10:00:00Z",
                updated_at: "2026-11-23T10:00:00Z",
              }),
              { status: 201 },
            ),
          );
        }
        if (url.endsWith("/api/v2/characters")) {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }),
    );

    const host = mount(
      <ReaderPage />,
      "/courses/course-1/materials/mat-1/read",
      "/courses/:courseId/materials/:materialId/read",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="reader-kp-kp-1"]')?.textContent).toContain("真题 5 次");
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="reader-passage-input"]');
    expect(textarea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "第一重要极限是微积分的重要基础");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const askBtn = host.querySelector<HTMLButtonElement>('[data-testid="reader-ask-btn"]');
    await act(async () => {
      askBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(host.querySelector('[data-testid="reader-explanation-card"]')?.textContent).toContain("等价无穷小");
    const saveBtn = host.querySelector<HTMLButtonElement>('[data-testid="reader-save-explain-btn"]');
    await act(async () => {
      saveBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(savedCalls).toHaveLength(1);
  });
});
