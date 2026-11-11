import { expect, test } from "@playwright/test";

test.use({ video: "off" });

const spaces = [
  {
    id: "space-orbit",
    name: "轨道力学",
    topic: "航天基础",
    goal: "理解霍曼转移",
    default_character_pack_id: "character-nova",
    material_count: 3,
    session_count: 2,
    created_at: "2026-11-01T08:00:00Z",
    updated_at: "2026-11-11T08:00:00Z",
  },
  {
    id: "space-writing",
    name: "短篇写作",
    topic: "叙事练习",
    goal: "完成第三章",
    default_character_pack_id: "character-echo",
    material_count: 1,
    session_count: 1,
    created_at: "2026-11-01T08:00:00Z",
    updated_at: "2026-11-10T08:00:00Z",
  },
];

const sessionFor = (id: string, spaceId: string, state: "idle" | "closed", updatedAt: string) => ({
  id,
  space_id: spaceId,
  character_pack_id: spaceId === "space-orbit" ? "character-nova" : "character-echo",
  state,
  created_at: "2026-11-11T07:00:00Z",
  updated_at: updatedAt,
});

async function mockRoomApi(page: import("@playwright/test").Page) {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/v1/vault/status") {
      await route.fulfill({ json: { initialized: true, unlocked: true } });
      return;
    }
    if (path === "/api/v1/spaces") {
      await route.fulfill({ json: spaces });
      return;
    }
    if (path === "/api/v1/providers/connections") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/v1/characters") {
      await route.fulfill({
        json: {
          items: [
            { id: "character-nova", name: "星澜", recipe: { avatar_model: "nova" } },
            { id: "character-echo", name: "沐音", recipe: { avatar_model: "echo" } },
          ],
        },
      });
      return;
    }
    if (path === "/api/v1/spaces/space-orbit/sessions") {
      await route.fulfill({
        json: [
          sessionFor("session-orbit-old", "space-orbit", "closed", "2026-11-09T09:00:00Z"),
          sessionFor("session-orbit-live", "space-orbit", "idle", "2026-11-11T09:00:00Z"),
        ],
      });
      return;
    }
    if (path === "/api/v1/spaces/space-writing/sessions") {
      await route.fulfill({
        json: [sessionFor("session-writing-live", "space-writing", "idle", "2026-11-11T10:00:00Z")],
      });
      return;
    }
    await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
  });
  return requests;
}

test.describe("interactive companion room", () => {
  test("keeps an API failure explicit until retry succeeds", async ({ page }) => {
    let spacesAttempt = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: true, unlocked: true } });
        return;
      }
      if (path === "/api/v1/spaces") {
        spacesAttempt += 1;
        if (spacesAttempt === 1) {
          await route.fulfill({ status: 503, json: { detail: "Temporary room outage" } });
          return;
        }
        await route.fulfill({ json: spaces });
        return;
      }
      if (path === "/api/v1/providers/connections") {
        await route.fulfill({ json: [] });
        return;
      }
      if (path === "/api/v1/characters") {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      if (path.endsWith("/sessions")) {
        await route.fulfill({ json: [] });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/room");
    const roomAlert = page.locator('[class*="_alert_"][role="alert"]');
    await expect(roomAlert).toContainText("Temporary room outage");
    await expect(page.getByRole("button", { name: "创建第一个学习空间" })).toHaveCount(0);

    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("link", { name: "开始轨道力学的共学" })).toBeVisible();
    await expect(roomAlert).toHaveCount(0);
  });

  test("turns an expired owner session into a Vault recovery step", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: true, unlocked: false } });
        return;
      }
      await route.fulfill({ status: 401, json: { detail: "Owner session required" } });
    });

    await page.goto("/room");

    await expect(page.getByRole("heading", { name: "先打开本地保险箱" })).toBeVisible();
    await expect(page.getByRole("link", { name: "前往解锁" })).toHaveAttribute("href", "/vault");
    await expect(page.getByRole("button", { name: "创建第一个学习空间" })).toHaveCount(0);
  });

  test("creates the first space only after the owner asks and does not pre-create a session", async ({ page }) => {
    const postPaths: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": new URL(page.url()).origin,
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
        return;
      }
      if (route.request().method() === "POST") {
        postPaths.push(path);
      }
      if (path === "/api/v1/vault/status") {
        await route.fulfill({ json: { initialized: true, unlocked: true } });
        return;
      }
      if (path === "/api/v1/spaces" && route.request().method() === "GET") {
        await route.fulfill({ json: [] });
        return;
      }
      if (path === "/api/v1/spaces" && route.request().method() === "POST") {
        await route.fulfill({
          headers: { "access-control-allow-origin": new URL(page.url()).origin },
          json: {
            id: "space-first",
            name: "我的陪伴空间",
            topic: "自由陪伴",
            goal: "从一段安静的共学开始",
            default_character_pack_id: null,
            created_at: "2026-11-11T12:00:00Z",
            updated_at: "2026-11-11T12:00:00Z",
          },
        });
        return;
      }
      if (path === "/api/v1/providers/connections") {
        await route.fulfill({ json: [] });
        return;
      }
      if (path === "/api/v1/characters") {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/room");
    await expect(page.getByRole("button", { name: "创建第一个学习空间" })).toBeVisible();
    expect(postPaths).toEqual([]);

    const createdResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/spaces"),
    );
    await page.getByRole("button", { name: "创建第一个学习空间" }).click();
    expect((await createdResponse).ok()).toBe(true);
    await expect(page).toHaveURL(/\/spaces\/space-first\/call\?view=immersive$/, { timeout: 60_000 });
    expect(postPaths).toEqual(["/api/v1/spaces"]);
  });

  test("resumes only the selected space and exposes keyboard-reachable room objects", async ({ page }) => {
    await mockRoomApi(page);
    await page.goto("/room");

    await expect(page.getByRole("heading", { name: "今晚，想从哪一页继续？" })).toBeVisible();
    await expect(page.getByRole("link", { name: "继续轨道力学的共学" })).toHaveAttribute(
      "href",
      "/spaces/space-orbit/call?session=session-orbit-live&view=immersive",
    );
    await expect(page.getByText("共学记录 2 次")).toBeVisible();
    await expect(page.getByRole("link", { name: "查看轨道力学的资料" })).toHaveAttribute(
      "href",
      "/spaces/space-orbit",
    );
    await expect(page.getByRole("link", { name: "挑选学习伙伴" })).toHaveAttribute("href", "/characters");
    await expect(page.getByRole("link", { name: "打开会话回忆" })).toHaveAttribute("href", "/sessions");

    const scene = page.locator("[data-room-scene]");
    await expect(scene).toHaveAttribute("data-parallax-enabled", "true");
    await scene.hover({ position: { x: 60, y: 80 } });
    await expect.poll(() => scene.evaluate((node) => node.style.getPropertyValue("--room-shift-x"))).not.toBe("0px");
    await page.mouse.move(0, 0);
    await expect.poll(() => scene.evaluate((node) => node.style.getPropertyValue("--room-shift-x"))).toBe("0px");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(scene).toHaveAttribute("data-parallax-enabled", "false");
    await expect.poll(() => scene.evaluate((node) => node.style.getPropertyValue("--room-shift-y"))).toBe("0px");

    await page.getByLabel("选择学习空间").selectOption("space-writing");
    await expect(page.getByRole("link", { name: "继续短篇写作的共学" })).toHaveAttribute(
      "href",
      "/spaces/space-writing/call?session=session-writing-live&view=immersive",
    );
    await expect(page.getByRole("link", { name: "继续短篇写作的共学" })).not.toHaveAttribute(
      "href",
      /session-orbit-live/,
    );
  });

  test("loads only the active space session without provider or unselected session requests", async ({ page }) => {
    const requests = await mockRoomApi(page);
    await page.goto("/room");

    await expect(page.getByRole("link", { name: "继续轨道力学的共学" })).toBeVisible();
    expect(requests).toContain("/api/v1/spaces");
    expect(requests).toContain("/api/v1/characters");
    expect(requests).toContain("/api/v1/spaces/space-orbit/sessions");
    expect(requests).not.toContain("/api/v1/providers/connections");
    expect(requests).not.toContain("/api/v1/spaces/space-writing/sessions");

    await page.getByLabel("选择学习空间").selectOption("space-writing");
    await expect(page.getByRole("link", { name: "继续短篇写作的共学" })).toBeVisible();
    expect(requests).toContain("/api/v1/spaces/space-writing/sessions");
  });

  test("does not render a late session response from the previously selected space", async ({ page }) => {
    let releaseOrbitSession: (() => void) | undefined;
    const orbitSessionPending = new Promise<void>((resolve) => {
      releaseOrbitSession = resolve;
    });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/spaces") {
        await route.fulfill({ json: spaces });
        return;
      }
      if (path === "/api/v1/characters") {
        await route.fulfill({
          json: { items: [{ id: "character-nova", name: "星澜", recipe: { avatar_model: "nova" } }] },
        });
        return;
      }
      if (path === "/api/v1/spaces/space-orbit/sessions") {
        await orbitSessionPending;
        await route.fulfill({ json: [sessionFor("session-orbit-live", "space-orbit", "idle", "2026-11-11T09:00:00Z")] });
        return;
      }
      if (path === "/api/v1/spaces/space-writing/sessions") {
        await route.fulfill({ json: [sessionFor("session-writing-live", "space-writing", "idle", "2026-11-11T10:00:00Z")] });
        return;
      }
      await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${path}` } });
    });

    await page.goto("/room");
    await expect(page.getByLabel("选择学习空间")).toBeVisible();
    await page.getByLabel("选择学习空间").selectOption("space-writing");
    await expect(page.getByRole("link", { name: "继续短篇写作的共学" })).toBeVisible();

    releaseOrbitSession?.();
    await expect(page.getByRole("link", { name: "继续短篇写作的共学" })).not.toHaveAttribute(
      "href",
      /session-orbit-live/,
    );
  });

  test("runs a deadline-based focus timer and remains overflow-free on mobile", async ({ page }) => {
    await mockRoomApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/room");

    await page.getByRole("button", { name: "15 分钟" }).click();
    await expect(page.getByLabel("专注倒计时")).toHaveText("15:00");
    await page.clock.install({ time: new Date("2026-11-11T12:00:00Z") });
    await page.getByRole("button", { name: "开始专注" }).click();
    await page.clock.fastForward(1250);
    await expect(page.getByLabel("专注倒计时")).toHaveText("14:59");
    await page.getByRole("button", { name: "暂停专注" }).click();
    await page.clock.fastForward(5000);
    await expect(page.getByLabel("专注倒计时")).toHaveText("14:59");

    const roomHotspot = page.getByRole("link", { name: "打开会话回忆" });
    await roomHotspot.scrollIntoViewIfNeeded();
    const hotspotHitTarget = await roomHotspot.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return hit === node || (hit instanceof Node && node.contains(hit));
    });
    expect(hotspotHitTarget).toBe(true);

    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBe(width.client);
  });

  test("keeps the portrait and room controls clear at narrow widths", async ({ page }) => {
    await mockRoomApi(page);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/room");

    const scene = page.locator("[data-room-scene]");
    const portrait = scene.locator("img");
    const note = scene.getByRole("complementary");
    const start = scene.getByRole("link", { name: "继续轨道力学的共学" });
    const partner = scene.getByRole("link", { name: "挑选学习伙伴" });
    await expect(portrait).toBeVisible();
    await expect(note).toContainText("星澜");
    const [picture, message, action, shortcut] = await Promise.all([
      portrait.boundingBox(), note.boundingBox(), start.boundingBox(), partner.boundingBox(),
    ]);
    expect(picture!.x + picture!.width).toBeLessThanOrEqual(message!.x);
    expect(action!.y + action!.height).toBeLessThanOrEqual(picture!.y);
    expect(Math.max(picture!.y + picture!.height, message!.y + message!.height)).toBeLessThanOrEqual(shortcut!.y);
    await expect(scene.locator('[class*="_roomBackground_"]')).toHaveCSS(
      "background-image", /observatory-mobile\.webp/,
    );
  });
});
