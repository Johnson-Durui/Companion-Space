import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const visualEvidenceDir = "test-results/ui-shell-visual";

async function captureVisualEvidence(page: import("@playwright/test").Page, name: string) {
  await mkdir(visualEvidenceDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: `${visualEvidenceDir}/${name}.png` });
}

test.use({ video: "off" });

const reflectionSpace = {
  id: "space-language",
  name: "日语听说",
  topic: "日常会话",
  goal: "每天开口练习 20 分钟",
  default_character_pack_id: null,
  material_count: 2,
  session_count: 1,
  knowledge_status: "ready",
  created_at: "2026-08-10T08:00:00Z",
  updated_at: "2026-08-13T09:30:00Z",
};

const reflectionChapterCases = [
  {
    path: "/memory",
    apiPath: "/api/v1/memory/space-language",
    loadingText: "正在整理回忆碎片…",
    contentText: "用户想把每日口语练习保持为稳定习惯。",
    payload: {
      items: [
        {
          id: "memory-language-habit",
          space_id: "space-language",
          content: "用户想把每日口语练习保持为稳定习惯。",
          status: "candidate",
          sensitive: false,
          source_session_id: null,
          created_at: "2026-08-12T19:00:00Z",
          updated_at: "2026-08-12T19:00:00Z",
        },
      ],
    },
  },
  {
    path: "/review-items",
    apiPath: "/api/v1/review-items/space-language",
    loadingText: "正在准备今日试炼…",
    contentText: "怎样用日语自然地介绍自己？",
    payload: {
      items: [
        {
          id: "review-language-introduction",
          space_id: "space-language",
          prompt: "怎样用日语自然地介绍自己？",
          answer: "先问候和介绍姓名，再礼貌收尾。",
          due_at: "2026-08-20T08:00:00Z",
          status: "pending",
          source_session_id: null,
          created_at: "2026-08-12T19:00:00Z",
          updated_at: "2026-08-12T19:00:00Z",
        },
      ],
    },
  },
] as const;

test.describe("responsive application shell", () => {
  test("turns a locked dashboard into a clear Vault recovery step", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: false, unlocked: false } });
        return;
      }
      await route.fulfill({ status: 401, json: { detail: "Owner session required" } });
    });

    await page.goto("/");

    await expect(page.getByText("Owner session required", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "初始化或解锁 Vault" })).toHaveAttribute("href", "/vault");
    await expect(page.getByRole("heading", { name: "先打开本地保险箱" })).toBeVisible();
    await expect(page.locator('[role="status"] .ant-spin')).toHaveCount(0);
  });

  test("keeps one clear landmark and visible keyboard focus on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: true, unlocked: true } });
        return;
      }
      if ([
        "/api/v1/spaces",
        "/api/v1/providers/connections",
      ].includes(path)) {
        await route.fulfill({ json: [] });
        return;
      }
      if (path === "/api/v1/characters") {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      await route.fulfill({ status: 404, json: { detail: "Not found" } });
    });
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "主要导航" }).getByRole("link")).toHaveCount(5);
    await expect(page.getByRole("link", { name: "主舞台", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "开始陪伴" })).toBeEnabled();
    await captureVisualEvidence(page, "dashboard-1440");

    const skipLink = page.getByRole("link", { name: "跳到主要内容" });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeVisible();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await expect.poll(async () => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))).toEqual({ clientWidth: 1440, scrollWidth: 1440 });
  });

  test("uses My as a mobile profile index even when local data is partial", async ({ page }) => {
    test.setTimeout(90_000);
    const requests: string[] = [];
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: true, unlocked: false } });
        return;
      }
      if (path === "/api/v1/characters") {
        await route.fulfill({ status: 401, json: { detail: "Owner session required" } });
        return;
      }
      if (path === "/api/v1/providers/connections") {
        await route.fulfill({ json: [] });
        return;
      }
      await route.fulfill({ status: 404, json: { detail: "Not found" } });
    });

    await page.goto("/me");

    const navigation = page.getByRole("navigation", { name: "主要导航" });
    const myTab = navigation.locator(".mobile-tab-bar").getByRole("link", { name: "我的", exact: true });
    await expect(myTab).toHaveAttribute("href", "/me");
    await expect(myTab).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "我的" })).toBeVisible();
    await expect(page.getByRole("link", { name: "管理角色" })).toHaveAttribute("href", "/characters");
    await expect(page.getByRole("link", { name: "创建新角色" })).toHaveAttribute("href", "/characters#new-character");
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: /声音与模型/ })).toHaveAttribute("href", "/providers");
    await expect(main.getByRole("link", { name: /本地安全/ })).toHaveAttribute("href", "/vault");
    await expect(main.getByRole("link", { name: /偏好与本机状态/ })).toHaveAttribute("href", "/settings");
    await expect(page.getByText("已锁定", { exact: true })).toBeVisible();
    await expect(page.getByText("角色信息暂不可用", { exact: true })).toBeVisible();

    expect(requests).toEqual(expect.arrayContaining([
      "/api/v1/vault/status",
      "/api/v1/characters",
      "/api/v1/providers/connections",
    ]));
    expect(requests.some((path) => path.includes("spaces") || path.includes("sessions"))).toBe(false);

    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      smallestTarget: Math.min(
        ...[...document.querySelectorAll<HTMLElement>('main a')]
          .filter((link) => link.getClientRects().length > 0)
          .map((link) => link.getBoundingClientRect().height),
      ),
    }));
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    expect(metrics.smallestTarget).toBeGreaterThanOrEqual(44);

    for (const path of ["/characters", "/providers", "/vault", "/settings"]) {
      await page.goto(path);
      await expect(navigation.locator(".mobile-tab-bar").getByRole("link", { name: "我的", exact: true })).toHaveAttribute("aria-current", "page");
    }
  });

  for (const chapter of reflectionChapterCases) {
    test(`loads ${chapter.path} inside the mobile reflection task`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/spaces") {
          await route.fulfill({ json: [reflectionSpace] });
          return;
        }
        if (path === chapter.apiPath) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await route.fulfill({ json: chapter.payload });
          return;
        }
        await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
      });

      await page.goto(chapter.path);

      await expect(page.getByText(chapter.loadingText, { exact: true })).toBeVisible();
      await expect(page.getByText(chapter.contentText, { exact: true }).first()).toBeVisible();
      const navigation = page.getByRole("navigation", { name: "主要导航" });
      await expect(navigation.getByRole("link")).toHaveCount(5);
      await expect(navigation.locator(".mobile-tab[aria-current='page']")).toContainText("复盘");
    });
  }

  test("moves a confirmed memory from calibration into the archive", async ({ page }) => {
    let status = "candidate";
    const confirmRequests: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/spaces") {
        await route.fulfill({ json: [reflectionSpace] });
        return;
      }
      if (path === "/api/v1/memory/space-language") {
        await route.fulfill({
          json: {
            items: [{
              id: "memory-language-habit",
              space_id: "space-language",
              content: "用户想把每日口语练习保持为稳定习惯。",
              status,
              sensitive: false,
              source_session_id: null,
              created_at: "2026-08-12T19:00:00Z",
              updated_at: "2026-08-12T19:00:00Z",
            }],
          },
        });
        return;
      }
      if (path === "/api/v1/memory/space-language/memory-language-habit/confirm") {
        confirmRequests.push(route.request().method());
        status = "confirmed";
        await route.fulfill({
          json: {
            id: "memory-language-habit",
            space_id: "space-language",
            content: "用户想把每日口语练习保持为稳定习惯。",
            status,
            sensitive: false,
            source_session_id: null,
            created_at: "2026-08-12T19:00:00Z",
            updated_at: "2026-08-12T19:01:00Z",
          },
        });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/memory");
    await page.getByRole("button", { name: "留下这段记忆" }).click();

    await expect(page.getByText("已确认记忆", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "留下这段记忆" })).toHaveCount(0);
    expect(confirmRequests).toEqual(["POST"]);
  });

  test("keeps the review answer hidden until reveal and records completion", async ({ page }) => {
    const answer = "先问候和介绍姓名，再礼貌收尾。";
    let status = "pending";
    const updatePayloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/spaces") {
        await route.fulfill({ json: [reflectionSpace] });
        return;
      }
      if (path === "/api/v1/review-items/space-language") {
        await route.fulfill({
          json: {
            items: [{
              id: "review-language-introduction",
              space_id: "space-language",
              prompt: "怎样用日语自然地介绍自己？",
              answer,
              due_at: "2026-08-20T08:00:00Z",
              status,
              source_session_id: null,
              created_at: "2026-08-12T19:00:00Z",
              updated_at: "2026-08-12T19:00:00Z",
            }],
          },
        });
        return;
      }
      if (path === "/api/v1/review-items/space-language/review-language-introduction") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        updatePayloads.push(payload);
        status = String(payload.status);
        await route.fulfill({
          json: {
            id: "review-language-introduction",
            space_id: "space-language",
            prompt: payload.prompt,
            answer: payload.answer,
            due_at: payload.due_at,
            status,
            source_session_id: null,
            created_at: "2026-08-12T19:00:00Z",
            updated_at: "2026-08-12T19:01:00Z",
          },
        });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/review-items");
    const trial = page.locator('section[aria-labelledby="active-trial-heading"]');
    await expect(page.getByLabel(/^复习列表答案-/)).not.toBeVisible();
    await expect(trial.getByText(answer, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看答案" }).click();
    await expect(trial.getByText(answer, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "记住了" }).click();

    await expect(page.getByText("今日试炼完成", { exact: true }).last()).toBeVisible();
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]?.status).toBe("completed");
  });

  test("keeps the character library first and progressively reveals creation tools", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/characters") {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      if (path === "/api/v1/vault/preferences") {
        await route.fulfill({
          json: {
            adult_relationships_enabled: false,
            adult_age_confirmed_at: null,
          },
        });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/characters");

    const library = page.getByRole("heading", { level: 2, name: "已保存的伙伴" });
    const createDisclosure = page.locator("details#new-character");
    const importDisclosure = page.locator("details").filter({ hasText: "导入已有角色（高级）" });

    await expect(library).toBeVisible();
    await expect(createDisclosure).toHaveJSProperty("open", false);
    await expect(importDisclosure).toHaveJSProperty("open", false);
    expect(await library.evaluate((node) => Boolean(node.compareDocumentPosition(document.querySelector("#new-character")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

    await page.goto("/characters#new-character");
    await expect(createDisclosure).toHaveJSProperty("open", true);
    await expect(page.getByRole("heading", { name: "新角色草稿" })).toBeVisible();
  });

  test("launches study from the selected space without prefetching call data", async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/api/v1/spaces") {
        await route.fulfill({
          json: [
            {
              id: "space-recent",
              name: "日语听说",
              topic: "日常会话",
              goal: "每天开口练习 20 分钟",
              default_character_pack_id: null,
              created_at: "2026-08-12T08:00:00Z",
              updated_at: "2026-08-12T09:00:00Z",
            },
            {
              id: "space-algorithms",
              name: "算法训练",
              topic: "数据结构",
              goal: "完成本周题单",
              default_character_pack_id: null,
              created_at: "2026-08-11T08:00:00Z",
              updated_at: "2026-08-11T09:00:00Z",
            },
          ],
        });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/study");

    const launcher = page.getByLabel("今天想在哪个空间一起学习？");
    const launchLink = launcher.getByRole("link", { name: "开始共学" });
    await expect(launchLink).toHaveAttribute("href", "/spaces/space-recent/call");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("navigation", { name: "主要导航" })
      .getByRole("link", { name: "开始共学", exact: true })).toHaveAttribute("aria-current", "page");
    await launcher.getByRole("radio", { name: /算法训练/ }).check();
    await expect(launchLink).toHaveAttribute("href", "/spaces/space-algorithms/call");
    expect(requests).toEqual(["/api/v1/spaces"]);
    await launchLink.click();
    await expect(page).toHaveURL(/\/spaces\/space-algorithms\/call$/);
    await expect.poll(() => requests.includes("/api/v1/spaces/space-algorithms")).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/study$/);
    await page.setViewportSize({ width: 768, height: 900 });
    await captureVisualEvidence(page, "study-768");
    await page.setViewportSize({ width: 375, height: 812 });
    await captureVisualEvidence(page, "study-375");
  });

  test("guides an empty study launcher to space management", async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/api/v1/spaces") {
        await route.fulfill({ json: [] });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/study");

    await expect(page.getByRole("heading", { name: "先创建一个学习空间" })).toBeVisible();
    await expect(page.getByRole("link", { name: "去管理学习空间" })).toHaveAttribute("href", "/spaces");
    await expect(page.getByLabel("今天想在哪个空间一起学习？")
      .getByRole("link", { name: "开始共学" })).toHaveCount(0);
    expect(requests).toEqual(["/api/v1/spaces"]);
  });

  for (const width of [768, 375]) {
    test(`keeps the ${width}px shell reachable without page overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.route("**/api/v1/vault/status", async (route) => {
        await route.fulfill({ json: { initialized: false, unlocked: false } });
      });
      await page.goto("/vault");

      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const navigation = page.getByRole("navigation", { name: "主要导航" });
      await expect(navigation.getByRole("link")).toHaveCount(5);
      await expect(page.locator('form[aria-label^="Vault"]')).toHaveCount(1);
      const activeLink = navigation.locator('.mobile-tab[aria-current="page"]');
      await expect.poll(async () => activeLink.evaluate((link, viewportWidth) => {
        const scroller = link.closest<HTMLElement>(".mobile-tab-bar");
        if (!scroller) {
          return false;
        }
        const linkBounds = link.getBoundingClientRect();
        const scrollerBounds = scroller.getBoundingClientRect();
        return linkBounds.left >= scrollerBounds.left - 1 && linkBounds.right <= scrollerBounds.right + 1;
      }, width)).toBe(true);

      const metrics = await page.evaluate(() => {
        const navLinks = [...document.querySelectorAll<HTMLElement>("nav a")]
          .filter((link) => link.getClientRects().length > 0);
        const navScroller = document.querySelector<HTMLElement>(".nav-groups");
        const formControls = [...document.querySelectorAll<HTMLElement>("input, textarea, select")];
        const visibleTargets = [...document.querySelectorAll<HTMLElement>("nav a, button, summary, .primary-button")]
          .filter((element) => element.getClientRects().length > 0);
        const contentSelectors = ".app-main, .page-stack, .hero-card, .content-grid, .vault-layout, .inset-panel";
        const contentOverflows = [...document.querySelectorAll<HTMLElement>(contentSelectors)]
          .some((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.left < -1 || bounds.right > document.documentElement.clientWidth + 1;
          });

        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          smallestNavTarget: Math.min(...navLinks.map((link) => link.getBoundingClientRect().height)),
          smallestVisibleTarget: Math.min(...visibleTargets.map((target) => target.getBoundingClientRect().height)),
          navScrollsInline: Boolean(navScroller && navScroller.scrollWidth > navScroller.clientWidth),
          formControlFontSizes: formControls.map((control) => Number.parseFloat(getComputedStyle(control).fontSize)),
          contentOverflows,
        };
      });

      expect(metrics.scrollWidth).toBe(metrics.clientWidth);
      expect(metrics.contentOverflows).toBe(false);
      expect(metrics.smallestNavTarget).toBeGreaterThanOrEqual(44);
      expect(metrics.smallestVisibleTarget).toBeGreaterThanOrEqual(44);
      expect(metrics.navScrollsInline).toBe(false);
      if (width === 375) {
        expect(metrics.formControlFontSizes.length).toBeGreaterThan(0);
        expect(metrics.formControlFontSizes.every((size) => size >= 16)).toBe(true);
        await expect(page.locator("input:focus")).toHaveCount(0);
        await expect(navigation.locator('.mobile-tab[aria-current="page"]')).toContainText("我的");
        const studyLink = navigation.getByRole("link", { name: "共学", exact: true });
        await expect(studyLink).toHaveAttribute(
          "href",
          "/study",
        );
        await Promise.all([
          page.waitForURL(/\/study$/),
          studyLink.click(),
        ]);
        await expect(navigation.locator('.mobile-tab[aria-current="page"]')).toContainText("共学");
      } else {
        await page.goto("/study");
        await expect(navigation.locator('.mobile-tab[aria-current="page"]')).toContainText("共学");
      }
    });
  }
});
