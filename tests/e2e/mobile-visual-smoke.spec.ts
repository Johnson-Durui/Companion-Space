import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const visualEvidenceDir = "test-results/mobile-app-visual";

const spaces = [
  {
    id: "space-language",
    name: "日语听说",
    topic: "日常会话",
    goal: "每天开口练习 20 分钟",
    default_character_pack_id: "character-mori",
    material_count: 6,
    session_count: 4,
    knowledge_status: "ready",
    created_at: "2026-08-10T08:00:00Z",
    updated_at: "2026-08-13T09:30:00Z",
  },
  {
    id: "space-design",
    name: "产品设计",
    topic: "交互与视觉",
    goal: "完成 Companion Space 的移动端打磨",
    default_character_pack_id: null,
    material_count: 12,
    session_count: 7,
    knowledge_status: "ready",
    created_at: "2026-08-08T08:00:00Z",
    updated_at: "2026-08-12T18:20:00Z",
  },
];

const moriCharacter = {
  id: "character-mori",
  name: "Mori",
  description: "陪你整理学习节奏的本地伙伴",
  recipe: {
    avatar_framing: "full_body",
    avatar_model: "mori_2d",
    stage_background: "study",
    base_model: "mini",
    face_style: "soft",
    hairstyle: "short_bob",
    outfit: "academy",
    accessories: [],
    palette: {
      skin_tone: "#f3d3c3",
      hair_color: "#5d718d",
      eye_color: "#9ed2ff",
      outfit_color: "#29354a",
      accent_color: "#77d7d1",
    },
    personality: "gentle",
    warmth: 72,
    initiative: 58,
    humor: 44,
    challenge: 34,
    relationship_role: "friend",
    voice_provider: "mock",
    voice_model: "mock-voice",
    voice_id: "default",
    speaking_rate: 1,
    motions: {
      idle: "/assets/characters/motions/companion-idle.vrma",
      listening: "/assets/characters/motions/companion-listening.vrma",
      thinking: "/assets/characters/motions/companion-thinking.vrma",
      speaking: "/assets/characters/motions/companion-speaking.vrma",
    },
  },
  asset_manifest: {},
  created_at: "2026-08-10T08:00:00Z",
  updated_at: "2026-08-13T09:30:00Z",
};

function session(id: string, spaceId: string, state: "speaking" | "closed", updatedAt: string) {
  return {
    id,
    space_id: spaceId,
    character_pack_id: null,
    state,
    summary: "",
    created_at: "2026-08-12T08:00:00Z",
    updated_at: updatedAt,
    ended_at: state === "closed" ? updatedAt : null,
  };
}

test("renders the redesigned primary mobile tabs without horizontal overflow", async ({ page }) => {
  await mkdir(visualEvidenceDir, { recursive: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/vault/status") {
      await route.fulfill({ json: { initialized: true, unlocked: true } });
      return;
    }
    if (path === "/api/v1/spaces") {
      await route.fulfill({ json: spaces });
      return;
    }
    if (path === "/api/v1/spaces/space-language") {
      await route.fulfill({
        json: {
          space: spaces[0],
          materials: [],
          jobs: [],
          assignments: [
            {
              id: "assignment-tts",
              space_id: "space-language",
              capability: "tts",
              provider_connection_id: "builtin-mock",
              model_name: "mock-voice-v1",
              created_at: "2026-08-10T08:00:00Z",
              updated_at: "2026-08-10T08:00:00Z",
            },
          ],
        },
      });
      return;
    }
    if (path === "/api/v1/spaces/space-language/sessions") {
      await route.fulfill({ json: [session("session-closed", "space-language", "closed", "2026-08-12T19:00:00Z")] });
      return;
    }
    if (path === "/api/v1/spaces/space-design/sessions") {
      await route.fulfill({ json: [session("session-active", "space-design", "speaking", "2026-08-14T10:10:00Z")] });
      return;
    }
    if (path === "/api/v1/providers/connections") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/v1/characters") {
      await route.fulfill({ json: { items: [moriCharacter] } });
      return;
    }
    if (path === "/api/v1/characters/character-mori") {
      await route.fulfill({ json: moriCharacter });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: `Unexpected request: ${path}` } });
  });

  for (const [path, name, heading, activeTab, loadedText] of [
    ["/", "today-375", "今天，和Mori去哪里？", "今日", "NEXT CHAPTER"],
    ["/spaces", "spaces-375", "学习空间", "空间", "日语听说"],
    ["/study", "study-375", "今天想学什么？", "共学", "路线选择"],
    ["/sessions", "sessions-375", "最近会话", "复盘", "产品设计 · 会话复盘"],
    ["/me", "me-375", "我的", "我的", "CURRENT COMPANION"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(loadedText, { exact: false }).first()).toBeVisible();
    await expect(page.locator(".mobile-tab[aria-current='page']")).toContainText(activeTab);
    await expect(page.locator(".mobile-tab-bar")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))).toEqual({ clientWidth: 375, scrollWidth: 375 });
    await page.screenshot({ path: `${visualEvidenceDir}/${name}.png` });

    if (path === "/sessions") {
      await expect(page.getByRole("link", { name: "继续这一章" })).toHaveAttribute(
        "href",
        "/spaces/space-design/call?session=session-active",
      );
    }
  }

});
