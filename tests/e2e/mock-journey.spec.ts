import { readFileSync } from "node:fs";

import { expect, test, type Page, type Request } from "@playwright/test";

const vaultPassword = "m7-playwright-pass";
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:8100";
const runSuffix = Date.now().toString(36);
const spaceName = `E2E 二分空间 ${runSuffix}`;
const characterName = `E2E Nova ${runSuffix}`;
const importedCharacterName = `E2E Card V3 ${runSuffix}`;
const importedPersona = `会用清晰类比讲解概念的图书管理员 ${runSuffix}`;
const importedScenario = `正在为一场深夜算法复习提供陪伴 ${runSuffix}`;
const importedSystemPromptSecret = `SYSTEM_PROMPT_SECRET_${runSuffix}`;
const importedPostHistorySecret = `POST_HISTORY_SECRET_${runSuffix}`;
const noteTitle = `二分查找速记 ${runSuffix}`;
const noteContent = [
  "二分查找依赖答案在搜索区间上具有单调性。",
  "如果 mid 满足条件，可以安全丢弃一半区间。",
  "如果区间不单调，就无法保证舍弃的一半永远不含正确答案。",
].join("\n");
const firstQuestion = "请画一张白板解释为什么二分查找要求区间单调？";
const launcherQuestion = `先陪我聊一句 ${runSuffix}`;
const launcherFollowupQuestion = `继续刚才那段陪伴 ${runSuffix}`;
const followupQuestion = "把这个结论压成三条复习卡片。";
const demoTopic = "为什么二分查找要求区间单调";
const editedSummary = "我已经能用单调性解释二分查找为什么可以安全舍弃一半区间。";
const editedNotes = "下次先从一个不单调的反例开始复习。";
const editedReviewPrompt = "如果判断结果不单调，二分查找为什么会失效？";
const editedReviewAnswer = "因为一次判断不再能证明某一半区间一定没有答案。";
const scheduledReviewAt = "2030-06-15T09:30";
const studioOptionCounts = {
  body: 2,
  background: 3,
  framing: 2,
  face: 4,
  hair: 6,
  outfit: 4,
  accessories: 6,
} as const;

test("fresh clone mock journey completes unlock to memory confirmation", async ({ page }) => {
  test.setTimeout(300_000);
  let spaceDetailHref = "";
  let reviewHref = "";
  let reviewItemsHref = "";
  let sessionId = "";
  let launcherSpaceId = "";
  let launcherSessionId = "";
  const ownerToken = await initializeAndUnlockVault(page);

  await test.step("launcher creates the first space without creating a session", async () => {
    const blankSpacesRoute = "**/api/v1/spaces";
    await page.route(blankSpacesRoute, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: [] });
        return;
      }
      await route.continue();
    });
    const sessionPosts = watchSessionPosts(page);

    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /创建空间并开始|开始陪伴/ });
    await expect(launcher).toBeEnabled();
    const createSpaceResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/spaces") && response.request().method() === "POST",
    );
    await launcher.click();
    const space = (await (await createSpaceResponse).json()) as { id: string; name: string };
    launcherSpaceId = space.id;

    await expect(page).toHaveURL(new RegExp(`/spaces/${launcherSpaceId}/call$`), {
      timeout: 60_000,
    });
    await expect(page.getByPlaceholder(/输入消息/)).toBeVisible({ timeout: 60_000 });
    expect(space.name).toBe("我的陪伴空间");
    await page.unroute(blankSpacesRoute);
    sessionPosts.stop();
    expect(sessionPosts.requests).toHaveLength(0);
  });

  await test.step("first launcher message persists one session and its transcript", async () => {
    const sessionResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/sessions") && response.request().method() === "POST",
    );
    await page.getByPlaceholder(/输入消息/).fill(launcherQuestion);
    await page.getByRole("button", { name: "发送文本" }).click();
    launcherSessionId = ((await (await sessionResponse).json()) as { id: string }).id;

    await expect(page.locator('[data-role="user"]').last()).toContainText(launcherQuestion);
    await expect(page.locator('[data-role="assistant"]').last()).toBeVisible({ timeout: 20_000 });
    const persisted = await getSessionTranscript(page, ownerToken, launcherSessionId);
    expect(persisted.session.space_id).toBe(launcherSpaceId);
    expect(
      persisted.turns.some(
        (turn) => turn.role === "user" && turn.display_text === launcherQuestion,
      ),
    ).toBe(true);
    expect(persisted.turns.some((turn) => turn.role === "assistant")).toBe(true);
  });

  await test.step("launcher resumes the same active session after dashboard navigation and reload", async () => {
    const sessionPosts = watchSessionPosts(page);

    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /继续最近会话|继续陪伴/ });
    await expect(launcher).toBeEnabled();
    const firstHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await launcher.click();
    await firstHydration;
    const resumePath = `/spaces/${launcherSpaceId}/call?session=${launcherSessionId}`;
    await expect(page).toHaveURL(new RegExp(`${resumePath.replace("?", "\\?")}$`), {
      timeout: 60_000,
    });
    await expect(page.locator('[data-role="user"]')).toContainText(launcherQuestion);

    const reloadHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await page.reload();
    expect((await reloadHydration).status()).toBe(401);
    await expect(
      page.getByRole("complementary").getByText("Owner session required", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);

    await unlockVaultForBrowser(page);
    await navigateViaSidebar(page, "主舞台");
    const unlockedLauncher = page.getByRole("button", {
      name: /继续最近会话|继续陪伴/,
    });
    await expect(unlockedLauncher).toBeEnabled();
    const unlockedHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await unlockedLauncher.click();
    await unlockedHydration;
    await expect(page).toHaveURL(new RegExp(`${resumePath.replace("?", "\\?")}$`), {
      timeout: 60_000,
    });
    await expect(page.locator('[data-role="user"]')).toContainText(launcherQuestion);

    const previousAssistantCount = await page.locator('[data-role="assistant"]').count();
    await page.getByPlaceholder(/输入消息/).fill(launcherFollowupQuestion);
    await page.getByRole("button", { name: "发送文本" }).click();
    await expect(page.locator('[data-role="user"]').last()).toContainText(
      launcherFollowupQuestion,
    );
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(
      previousAssistantCount + 1,
      { timeout: 20_000 },
    );
    const persisted = await getSessionTranscript(page, ownerToken, launcherSessionId);
    expect(
      persisted.turns.some(
        (turn) =>
          turn.role === "user" && turn.display_text === launcherFollowupQuestion,
      ),
    ).toBe(true);
    sessionPosts.stop();
    expect(sessionPosts.requests).toHaveLength(0);
  });

  await test.step("adult relationship mode requires an explicit owner confirmation", async () => {
    await navigateViaSidebar(page, "设置");
    await expect(page.getByText("当前状态：Disabled")).toBeVisible();

    await navigateViaSidebar(page, "角色工作室");
    const createDisclosure = await openCharacterDisclosure(page, "创建新角色");
    const loverOption = createDisclosure.getByRole("button", { name: /^Lover/ });
    await expect(loverOption).toBeDisabled();
    await expect(page.getByText(/成人关系模式当前关闭/)).toBeVisible();

    await navigateViaSidebar(page, "设置");
    const enableButton = page.getByRole("button", { name: "开启成人关系模式" });
    await expect(enableButton).toBeDisabled();
    await page.getByLabel("我确认当前本机拥有者已满 18 岁").check();
    await expect(enableButton).toBeEnabled();
    await enableButton.click();
    await expect(page.getByText("当前状态：Enabled")).toBeVisible();

    await navigateViaSidebar(page, "角色工作室");
    const enabledCreateDisclosure = await openCharacterDisclosure(page, "创建新角色");
    await expect(enabledCreateDisclosure.getByRole("button", { name: /^Lover/ })).toBeEnabled();

    await navigateViaSidebar(page, "设置");
    await page.getByRole("button", { name: "关闭成人关系模式" }).click();
    await expect(page.getByText("当前状态：Disabled")).toBeVisible();
  });

  await test.step("mock provider is visible in provider registry", async () => {
    await navigateViaSidebar(page, "模型中心");
    await expect(page.getByRole("heading", { name: "Provider Connections" })).toBeVisible();
    await expect(page.getByText(/mock-companion-v1/)).toBeVisible();
    await expect(
      page.getByText("chat_llm / analysis_llm / embedding / stt / tts").first(),
    ).toBeVisible();
  });

  await test.step("create a study space", async () => {
    await navigateViaSidebar(page, "学习空间");
    await page.getByLabel("空间名称").fill(spaceName);
    await page.getByLabel("主题").fill("算法与单调性");
    await page.getByLabel("目标").fill("理解二分查找的边界条件");
    await page.getByRole("button", { name: "创建空间" }).click();

    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    await expect(spaceCard).toBeVisible();
    await expect(spaceCard).toContainText("暂无资料");
    const detailLink = spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ });
    spaceDetailHref = (await detailLink.getAttribute("href")) ?? "";
    await Promise.all([
      page.waitForURL(/\/spaces\/.+/, { timeout: 10_000 }),
      detailLink.click(),
    ]);
    await expect(page.getByLabel("笔记标题")).toBeVisible();
  });

  await test.step("cross-space session query neither leaks transcript nor creates a session", async () => {
    const targetSpaceId = decodeURIComponent(spaceDetailHref.split("/").filter(Boolean).at(-1) ?? "");
    const sessionRoute = `**/api/v1/sessions/${launcherSessionId}`;
    await page.route(sessionRoute, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as { session: { space_id: string } };
      payload.session.space_id = targetSpaceId;
      await route.fulfill({ response, json: payload });
    });
    const sessionPosts = watchSessionPosts(page);

    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /继续最近会话|继续陪伴/ });
    await expect(launcher).toBeEnabled();
    const rejectedHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await launcher.click();
    await rejectedHydration;

    await expect(
      page.getByRole("complementary").getByText("链接中的会话不属于当前空间，已拒绝恢复。"),
    ).toBeVisible();
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);
    sessionPosts.stop();
    expect(sessionPosts.requests).toHaveLength(0);
    await page.unroute(sessionRoute);
    await navigateViaSidebar(page, "学习空间");
    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    await spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ }).click();
    await expect(page.getByLabel("笔记标题")).toBeVisible();
  });

  await test.step("missing restored character binding fails closed", async () => {
    const sessionRoute = `**/api/v1/sessions/${launcherSessionId}`;
    await page.route(sessionRoute, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as {
        session: Record<string, unknown>;
      };
      delete payload.session.character_pack_id;
      await route.fulfill({ response, json: payload });
    });
    const sessionPosts = watchSessionPosts(page);

    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /继续最近会话|继续陪伴/ });
    await expect(launcher).toBeEnabled();
    const rejectedHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await launcher.click();
    await rejectedHydration;

    await expect(page.getByRole("complementary").getByText(/session\.character_pack_id/)).toBeVisible();
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);
    sessionPosts.stop();
    expect(sessionPosts.requests).toHaveLength(0);
    await page.unroute(sessionRoute);
    await navigateViaSidebar(page, "学习空间");
    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    await spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ }).click();
    await expect(page.getByLabel("笔记标题")).toBeVisible();
  });

  await test.step("malformed session query is rejected before any session request", async () => {
    const sessionsRoute = `**/api/v1/spaces/${launcherSpaceId}/sessions`;
    await page.route(sessionsRoute, async (route) => {
      const response = await route.fetch();
      const sessions = (await response.json()) as Array<{ id: string; updated_at: string }>;
      const launcherSession = sessions.find((session) => session.id === launcherSessionId);
      if (!launcherSession) {
        throw new Error("Launcher session was missing from its space session list.");
      }
      await route.fulfill({
        response,
        json: [{ ...launcherSession, id: "not-a-session", updated_at: "2100-01-01T00:00:00Z" }],
      });
    });
    const sessionPosts = watchSessionPosts(page);
    const sessionGets: string[] = [];
    const recordSessionGet = (request: Request) => {
      if (request.method() === "GET" && request.url().includes("/api/v1/sessions/")) {
        sessionGets.push(request.url());
      }
    };
    page.on("request", recordSessionGet);

    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /继续最近会话|继续陪伴/ });
    await expect(launcher).toBeEnabled();
    await launcher.click();
    await expect(
      page.getByRole("complementary").getByText("链接中的会话 ID 格式无效，已拒绝恢复。"),
    ).toBeVisible();
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);

    sessionPosts.stop();
    page.off("request", recordSessionGet);
    expect(sessionPosts.requests).toHaveLength(0);
    expect(sessionGets).toHaveLength(0);
    await page.unroute(sessionsRoute);
    await navigateViaSidebar(page, "学习空间");
    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    await spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ }).click();
    await expect(page.getByLabel("笔记标题")).toBeVisible();
  });

  await test.step("closed session query neither restores transcript nor creates a session", async () => {
    const sessionRoute = `**/api/v1/sessions/${launcherSessionId}`;
    await page.route(sessionRoute, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as { session: { state: string } };
      payload.session.state = "closed";
      await route.fulfill({ response, json: payload });
    });

    const sessionPosts = watchSessionPosts(page);
    await navigateViaSidebar(page, "主舞台");
    const launcher = page.getByRole("button", { name: /继续最近会话|继续陪伴/ });
    await expect(launcher).toBeEnabled();
    const rejectedHydration = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/sessions/${launcherSessionId}`) && response.request().method() === "GET",
    );
    await launcher.click();
    await rejectedHydration;

    await expect(
      page.getByRole("complementary").getByText("链接中的会话已经结束，请从复盘页查看记录或开始新会话。"),
    ).toBeVisible();
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);
    sessionPosts.stop();
    expect(sessionPosts.requests).toHaveLength(0);
    await page.unroute(sessionRoute);
    await navigateViaSidebar(page, "学习空间");
    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    await spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ }).click();
    await expect(page.getByLabel("笔记标题")).toBeVisible();
  });

  await test.step("paste note and wait for indexing completion", async () => {
    await page.getByLabel("笔记标题").fill(noteTitle);
    await page.getByLabel("内容").fill(noteContent);
    await page.getByRole("button", { name: "保存笔记" }).click();

    const materialCard = page.locator("article.info-card").filter({ hasText: noteTitle });
    await expect(materialCard).toBeVisible();
    await expect(materialCard.getByText("已完成")).toBeVisible({ timeout: 15_000 });
  });

  await test.step("import a Character Card V3 JSON and inspect the persisted profile", async () => {
    await navigateViaSidebar(page, "角色工作室");
    const importDisclosure = await openCharacterDisclosure(page, "导入已有角色（高级）");
    const characterCardV3 = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: importedCharacterName,
        description: "一位耐心且重视证据的学习伙伴。",
        personality: importedPersona,
        scenario: importedScenario,
        first_mes: "今晚想先复习哪个概念？",
        mes_example: "<START>\n{{char}}: 我们可以先画出边界。",
        creator_notes: "Playwright canonical V3 fixture",
        system_prompt: importedSystemPromptSecret,
        post_history_instructions: importedPostHistorySecret,
        alternate_greetings: [],
        tags: ["study", "e2e"],
        creator: "Companion Space E2E",
        character_version: "1.0",
        extensions: {},
        group_only_greetings: [],
        source: [],
        assets: [],
      },
    };
    await Promise.all([
      page.waitForURL(/\/characters\/.+/, { timeout: 60_000 }),
      importDisclosure.locator('input[type="file"][accept*=".json"]').setInputFiles({
        name: `character-card-v3-${runSuffix}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(characterCardV3), "utf8"),
      }),
    ]);
    await expect(page.getByRole("heading", { name: importedCharacterName }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Avatar Asset Readiness" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByLabel("Name")).toHaveValue(importedCharacterName);
    await expect(page.getByLabel("Description")).toHaveValue(new RegExp(importedPersona));
    await expect(page.getByLabel("Description")).toHaveValue(new RegExp(importedScenario));
    await expect(page.getByLabel("Description")).not.toHaveValue(new RegExp(importedSystemPromptSecret));
    await expect(page.getByLabel("Description")).not.toHaveValue(new RegExp(importedPostHistorySecret));
    await navigateViaSidebar(page, "角色工作室");
  });

  await test.step("create and save a character recipe", async () => {
    await openCharacterDisclosure(page, "创建新角色");
    await assertCharacterStudioOptionCounts(page);
    await expect(
      page.getByAltText("三位原创二次元学习伙伴，分别呈现温柔、元气与沉静的陪伴氛围"),
    ).toBeVisible();
    const featuredCompanions = [
      {
        id: "memory-navigator",
        name: "澄羽",
        model: "mira",
        voice: "Serena",
        warmth: 90,
        modelLabel: /^澄羽 · MIRA · painted-blender/,
        artAlt: "原创学习伙伴澄羽，身穿雾白与深海青短斗篷，手托发光的学习记录页",
      },
      {
        id: "short-round-captain",
        name: "曜柚",
        model: "kite",
        voice: "Eric",
        warmth: 72,
        modelLabel: /^曜柚 · KITE · painted-blender/,
        artAlt: "原创学习伙伴曜柚，身穿柚黄与松石绿运动夹克，向前做倒数手势",
      },
      {
        id: "constraint-senior",
        name: "凛序",
        model: "cael",
        voice: "Dylan",
        warmth: 48,
        modelLabel: /^凛序 · CAEL · painted-blender/,
        artAlt: "原创学习伙伴凛序，身穿墨蓝长风衣，在观测书室指出冰青色约束图形",
      },
      {
        id: "story-lantern",
        name: "弦灯",
        model: "lyra",
        voice: "Vivian",
        warmth: 84,
        modelLabel: /^弦灯 · LYRA · painted-blender/,
        artAlt: "原创学习伙伴弦灯，身穿炭紫与灯橙创作服，在暖灯工作室展开故事卡片",
      },
    ] as const;

    for (const companion of featuredCompanions) {
      const preset = page.getByTestId(`companion-preset-${companion.id}`);
      const artwork = page.getByAltText(companion.artAlt);
      await preset.scrollIntoViewIfNeeded();
      await expect(preset).toBeVisible();
      await expect(artwork).toBeVisible();
      await expect.poll(() => artwork.evaluate((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
      }), { timeout: 10_000 }).toBe(true);
      await preset.click();
      await expect(page.getByText(new RegExp(`已应用 ${companion.name} ·`))).toBeVisible();
      await expect(page.getByLabel("Name")).toHaveValue(companion.name);
      await expect(
        page.getByRole("group", { name: "Built-in avatar" }).getByRole("button", { name: companion.modelLabel }),
      ).toHaveAttribute("aria-pressed", "true");

      const recipeDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出配方" }).click();
      const downloadedRecipePath = await (await recipeDownload).path();
      expect(downloadedRecipePath).toBeTruthy();
      const exportedRecipe = JSON.parse(readFileSync(downloadedRecipePath as string, "utf8")) as {
        name?: string;
        recipe?: { avatar_model?: string; voice_id?: string; warmth?: number };
      };
      expect(exportedRecipe).toMatchObject({
        name: companion.name,
        recipe: {
          avatar_model: companion.model,
          voice_id: companion.voice,
          warmth: companion.warmth,
        },
      });
    }

    await page.getByText("更多节奏模板", { exact: true }).click();
    await expect(page.getByRole("button", { name: /^Focus Spark/ })).toBeVisible();
    await page.locator('input[type="file"][accept="application/json"]').setInputFiles({
      name: "legacy-stage-recipe.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({
        schema_version: "character_recipe_v1",
        name: "Legacy Stage",
        recipe: {
          avatar_model: "sendagaya_shino",
          avatar_framing: "portrait",
          base_model: "mini",
          face_style: "soft",
        },
      })),
    });
    await expect(page.getByText("已导入 legacy-stage-recipe.json。")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Stage Background" }).getByRole("button", { name: /^Neutral/ }),
    ).toHaveAttribute("aria-pressed", "true");
    const airiInspiredPreset = page.getByRole("button", {
      name: /^Stage Companion/,
    });
    await expect(airiInspiredPreset).toBeVisible();
    await airiInspiredPreset.click();
    await expect(page.getByText("已应用 Stage Companion 模板。")).toBeVisible();
    await assertStageCompanionRecipe(page, "Mio");
    const recipeDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出配方" }).click();
    const downloadedRecipePath = await (await recipeDownload).path();
    expect(downloadedRecipePath).toBeTruthy();
    const exportedRecipe = JSON.parse(readFileSync(downloadedRecipePath as string, "utf8")) as {
      recipe?: { stage_background?: string };
    };
    expect(exportedRecipe.recipe?.stage_background).toBe("midnight");
    await page.getByLabel("Name").fill(characterName);
    await page.getByRole("button", { name: "创建角色" }).click();

    const card = page.locator("article.info-card").filter({ hasText: characterName });
    await expect(card).toBeVisible({ timeout: 20_000 });
    const characterDetailLink = card.getByRole("link", { name: "进入详情" });
    await Promise.all([
      page.waitForURL(/\/characters\/.+/, { timeout: 60_000 }),
      characterDetailLink.click(),
    ]);

    await expect(page.getByRole("heading", { name: characterName }).first()).toBeVisible();
    await assertStageCompanionRecipe(page, characterName);
    const persistedCharacterUrl = page.url();
    await navigateViaSidebar(page, "角色工作室");
    const persistedCard = page.locator("article.info-card").filter({ hasText: characterName });
    await Promise.all([
      page.waitForURL(persistedCharacterUrl, { timeout: 60_000 }),
      persistedCard.getByRole("link", { name: "进入详情" }).click(),
    ]);
    await expect(
      page.getByRole("group", { name: "Stage Background" }).getByRole("button", { name: /^Midnight/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-avatar-state]").first()).toHaveAttribute(
      "data-avatar-stage-background",
      "midnight",
      { timeout: 60_000 },
    );
    const previewSpaceSelect = page.getByLabel("TTS 试听学习空间");
    await previewSpaceSelect.selectOption({ index: 1 });
    const targetSpaceId = await previewSpaceSelect.inputValue();
    const characterId = decodeURIComponent(
      persistedCharacterUrl.split("/").filter(Boolean).at(-1) ?? "",
    );
    type SpaceSnapshot = {
      id: string;
      name: string;
      topic: string;
      goal: string;
      default_character_pack_id: string | null;
    };
    const spacesBeforeResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(spacesBeforeResponse.status()).toBe(200);
    const spacesBefore = await spacesBeforeResponse.json() as SpaceSnapshot[];
    const targetBefore = spacesBefore.find((space) => space.id === targetSpaceId);
    expect(targetBefore).toBeDefined();
    if (!targetBefore) {
      throw new Error(`Selected space ${targetSpaceId} was missing before default-character bind.`);
    }
    expect(targetBefore.name).toBe(spaceName);
    expect(targetBefore.default_character_pack_id).not.toBe(characterId);
    const otherSpacesBefore = spacesBefore
      .filter((space) => space.id !== targetSpaceId)
      .sort((left, right) => left.id.localeCompare(right.id));

    const bindDefaultButton = page.getByRole("button", { name: "设为该空间默认角色" });
    const bindResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT"
        && new URL(response.url()).pathname
          === `/api/v1/spaces/${targetSpaceId}/default-character`,
    );
    await bindDefaultButton.click();
    const bindResponse = await bindResponsePromise;
    expect(new URL(bindResponse.url()).pathname).toBe(
      `/api/v1/spaces/${targetSpaceId}/default-character`,
    );
    expect(bindResponse.request().postDataJSON()).toEqual({ character_pack_id: characterId });
    expect(bindResponse.status()).toBe(200);

    const spacesAfterResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(spacesAfterResponse.status()).toBe(200);
    const spacesAfter = await spacesAfterResponse.json() as SpaceSnapshot[];
    const targetAfter = spacesAfter.find((space) => space.id === targetSpaceId);
    expect(targetAfter).toMatchObject({
      id: targetSpaceId,
      name: targetBefore.name,
      topic: targetBefore.topic,
      goal: targetBefore.goal,
      default_character_pack_id: characterId,
    });
    expect(
      spacesAfter
        .filter((space) => space.id !== targetSpaceId)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(otherSpacesBefore);
    await expect(
      page.getByText(`当前角色已经是「${spaceName}」的默认角色。`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(bindDefaultButton).toBeDisabled();
  });

  await test.step("run a text-first session with citations", async () => {
    await navigateViaSidebar(page, "学习空间");
    const spaceCard = page.locator("article.info-card").filter({ hasText: spaceName });
    const detailLink = spaceCard.getByRole("link", { name: /^(查看主题档案|进入主题)$/ });
    await Promise.all([
      page.waitForURL(spaceDetailHref || /\/spaces\/.+/, { timeout: 10_000 }),
      detailLink.click(),
    ]);
    await expect(page.getByRole("heading", { name: spaceName })).toBeVisible({ timeout: 60_000 });
    const callLink = page.getByRole("link", { name: "开始伴学会话" });
    await expect(callLink).toBeVisible({ timeout: 60_000 });
    await Promise.all([
      page.waitForURL(/\/call$/, { timeout: 60_000 }),
      callLink.click(),
    ]);

    await expect(page.getByRole("heading", { name: spaceName })).toBeVisible();
    await expect(page.getByText(`和 ${characterName} 一起`, { exact: true })).toBeVisible();
    const avatarViewport = page.locator("[data-avatar-state]").first();
    const runtimeCanvas = page.getByLabel("VRM character canvas").locator("canvas");
    await expect(avatarViewport).toHaveAttribute("data-avatar-emotion", "neutral");
    await expect(avatarViewport).toHaveAttribute("data-avatar-stage-background", "midnight");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-stage-background", "midnight");
    await page.getByLabel("发送文字消息").fill(firstQuestion);
    await page.getByRole("button", { name: "发送文本" }).click();

    const assistantTurn = page.locator('[data-role="assistant"]').last();
    await expect(assistantTurn).toContainText("二分查找", { timeout: 20_000 });
    await expect(assistantTurn).toContainText("资料命中");
    await expect(assistantTurn.getByText(noteTitle, { exact: true })).toBeVisible();
    await expect(avatarViewport).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-emotion", "playful");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-expression", "happy");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-expression-is-binary", "false");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-expression-override-blink", "none");
    await expect(runtimeCanvas).toHaveAttribute("data-avatar-expression-override-mouth", "none");
    await expect
      .poll(async () => Number.parseFloat(
        (await runtimeCanvas.getAttribute("data-avatar-expression-weight")) ?? "0",
      ), { timeout: 10_000 })
      .toBeGreaterThan(0.2);
    await expectVrmaStatePose(runtimeCanvas, "idle");
    const boardPanel = page.locator("section.panel").filter({ hasText: "当前板书" });
    await expect(boardPanel.getByText("关键概念")).toBeVisible({ timeout: 20_000 });
    await expect(boardPanel.getByText("因果关系")).toBeVisible();
    await expect(boardPanel.getByText("下一步问题")).toBeVisible();
    const reviewLink = page.getByRole("link", { name: /查看复盘/ });
    await expect(reviewLink).toBeVisible();
    reviewHref = (await reviewLink.getAttribute("href")) ?? "";
    sessionId = decodeURIComponent(reviewHref.split("/").filter(Boolean).at(-1) ?? "");
    expect(sessionId).toBeTruthy();
  });

  await test.step("request a demo, play it, pause it, and ask a follow-up", async () => {
    await page.getByLabel("演示主题").fill(demoTopic);
    await page.getByRole("button", { name: "演示一下" }).click();

    await expect(page.getByText("Script Ready")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("步骤 1/3")).toBeVisible();
    await expect(page.getByRole("button", { name: "播放" })).toBeVisible();
    const demoCitationCard = page
      .getByRole("heading", { name: "演示引用" })
      .locator("..")
      .locator("..");
    await expect(demoCitationCard).toBeVisible();
    await expect(demoCitationCard.getByText(noteTitle, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "播放" }).click();
    const pauseButton = page.getByRole("button", { name: "暂停" });
    await expect(pauseButton).toBeVisible({ timeout: 10_000 });
    await pauseButton.click();
    await expect(page.getByRole("button", { name: "播放" })).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("步骤 2/3")).toBeVisible();
    await page.getByRole("button", { name: "播放" }).click();
    await expect(page.getByRole("button", { name: "暂停" })).toBeVisible({ timeout: 10_000 });

    const assistantTurns = page.locator('[data-role="assistant"]');
    const assistantTurnCount = await assistantTurns.count();
    await page.getByLabel("播放中提问").fill(followupQuestion);
    await page.getByRole("button", { name: "停止并提问" }).click();

    const latestUserTurn = page.locator('[data-role="user"]').last();
    await expect(latestUserTurn).toContainText(followupQuestion, { timeout: 20_000 });
    await expect(assistantTurns).toHaveCount(assistantTurnCount + 1, { timeout: 20_000 });
    await expect(assistantTurns.last()).toContainText("模拟回复");

    const demoRoute = "**/api/v1/sessions/*/demos";
    await page.route(demoRoute, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as {
        script?: { steps?: Array<{ board?: { kind?: string; content?: string } }> };
      };
      const mermaidStep = payload.script?.steps?.find(
        (step) => step.board?.kind === "mermaid",
      );
      if (!mermaidStep?.board) {
        throw new Error("Mock LessonScript did not include the expected Mermaid step.");
      }
      mermaidStep.board.content = "flowchart LR\nA[broken -->";
      await route.fulfill({ response, json: payload });
    });
    await page.getByLabel("演示主题").fill(`${demoTopic}（故障降级）`);
    await page.getByRole("button", { name: "演示一下" }).click();
    await expect(page.getByText("步骤 1/3")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("步骤 2/3")).toBeVisible();
    await expect(page.getByText("Mermaid 无法渲染，已退回文本板书")).toBeVisible({
      timeout: 20_000,
    });
    await page.unroute(demoRoute);
  });

  await test.step("end the session and inspect the recap", async () => {
    expect(reviewHref).toBeTruthy();
    await page.getByRole("button", { name: "结束会话" }).click();
    await expect(page.getByRole("button", { name: "结束会话" })).toBeDisabled();
    await openSessionReview(page, reviewHref);

    await expect(page.getByRole("heading", { name: /Session Review|E2E 二分空间/i })).toBeVisible({ timeout: 60_000 });
    const citationsCard = page.locator("section.panel.inset-panel").filter({
      has: page.getByRole("heading", { name: "Citations" }),
    });
    const transcriptCard = page.locator("section.panel.inset-panel").filter({
      has: page.getByRole("heading", { name: "Transcript" }),
    });
    await expect(citationsCard.getByText(noteTitle, { exact: true })).toBeVisible();
    await expect(transcriptCard.getByText("伴学角色", { exact: true }).first()).toBeVisible();
    await expect(
      page.locator(".status-badge").filter({ hasText: "复盘已就绪" }),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step("edit, persist, and restore the recap", async () => {
    const summary = page.getByLabel("复盘摘要");
    const notes = page.getByLabel("复盘备注");
    await summary.fill(editedSummary);
    await notes.fill(editedNotes);
    await expect(page.getByText("已保存到本地空间")).toBeVisible({ timeout: 10_000 });

    await openSessionReview(page, reviewHref);
    await expect(summary).toHaveValue(editedSummary);
    await expect(notes).toHaveValue(editedNotes);
    await page.getByRole("button", { name: "恢复 AI 草稿" }).click();
    await expect(summary).not.toHaveValue(editedSummary);
    await expect(notes).toHaveValue("");
  });

  await test.step("confirm memory and edit the generated review item", async () => {
    const memoryRow = page.locator("article.editable-row").filter({ hasText: "待确认记忆" }).first();
    await expect(memoryRow).toBeVisible({ timeout: 15_000 });
    await memoryRow.getByRole("button", { name: "确认留下" }).click();
    await expect(page.locator("article.editable-row").filter({ hasText: "已确认记忆" }).first()).toBeVisible();

    const reviewPrompt = page.getByLabel(/^复习题干-/).first();
    await reviewPrompt.fill(editedReviewPrompt);
    await reviewPrompt.blur();
    await expect(page.getByText(editedReviewPrompt).first()).toBeVisible({ timeout: 10_000 });
    const reviewAnswer = page.getByLabel(/^复习答案-/).first();
    await reviewAnswer.fill(editedReviewAnswer);
    await reviewAnswer.blur();
    await expect(reviewAnswer).toHaveValue(editedReviewAnswer);
    const reviewDueAt = page.getByLabel(/^复盘复习到期时间-/).first();
    await reviewDueAt.fill(scheduledReviewAt);
    await reviewDueAt.blur();
    await expect(reviewDueAt).toHaveValue(scheduledReviewAt);
  });

  await test.step("confirm memory candidate", async () => {
    reviewItemsHref = await page.getByRole("link", { name: "查看空间复习" }).getAttribute("href") ?? "";
    expect(reviewItemsHref).toMatch(/^\/review-items\?spaceId=/);
    await page.getByRole("link", { name: "查看空间记忆" }).click();

    const memoryRow = page.locator("article.editable-row").first();
    await expect(memoryRow).toBeVisible({ timeout: 15_000 });
    await expect(memoryRow).toContainText("已确认记忆");
  });

  await test.step("review queue is populated", async () => {
    await openSessionReview(page, reviewHref);
    const reviewItemsLink = page.getByRole("link", { name: "查看空间复习" });
    await expect(reviewItemsLink).toHaveAttribute("href", reviewItemsHref);
    await reviewItemsLink.click();
    await expect(page).toHaveURL(/\/review-items\?spaceId=/);
    const reviewPromptField = page.getByLabel(/^复习列表题干-/).first();
    const reviewAnswerField = page.getByLabel(/^复习列表答案-/).first();
    const reviewDueAtField = page.getByLabel(/^复习列表到期时间-/).first();
    await expect(reviewPromptField).toBeVisible({ timeout: 15_000 });
    await expect(reviewPromptField).toHaveValue(editedReviewPrompt);
    await expect(reviewAnswerField).toHaveValue(editedReviewAnswer);
    await expect(reviewDueAtField).toHaveValue(scheduledReviewAt);
  });

  await test.step("local product signals keep demo narration outside realtime latency", async () => {
    await navigateViaSidebar(page, "设置");
    await expect(page.getByRole("heading", { name: "本机信号" })).toBeVisible();
    await expect(page.getByText("Activation 7/7")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Citation accuracy/)).toBeVisible();

    const events = await getLocalMetricEvents(page, ownerToken);
    const demoLatencySignal = events.items.find((item) =>
      item.event === "first_audio_latency_ms" && item.payload?.session_id === sessionId
    );
    expect(demoLatencySignal).toBeUndefined();
  });
});

test("activates an imported AIRI VRM for one session without changing the space default", async ({ page }) => {
  test.setTimeout(180_000);
  const ownerToken = await authorizeFocusedBrowser(page);
  const vrmBytes = readFileSync("apps/web/public/assets/characters/models/Sendagaya-Shino.vrm");
  const sourceDisplayModelPath = "models/Sendagaya-Shino.vrm";
  const sourceDisplayModelName = "Sendagaya Shino (CC0 E2E)";
  const remoteModelUrl = `https://assets.invalid/${runSuffix}/airi-model.vrm`;
  const importedName = `E2E AIRI VRM ${runSuffix}`;
  const spacesBeforeResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(spacesBeforeResponse.status()).toBe(200);
  type SessionTargetSpace = {
    id: string;
    name: string;
    topic: string;
    goal: string;
    default_character_pack_id?: string | null;
  };
  const spacesBefore = await spacesBeforeResponse.json() as SessionTargetSpace[];
  let targetSpace = spacesBefore.find((space) => space.default_character_pack_id) ?? spacesBefore[0];
  if (!targetSpace) {
    const createSpaceResponse = await page.request.post(`${apiBaseUrl}/api/v1/spaces`, {
      data: {
        name: `E2E AIRI 会话空间 ${runSuffix}`,
        topic: "会话级角色激活",
        goal: "验证临时角色不会改动空间默认角色",
      },
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(createSpaceResponse.status()).toBe(201);
    targetSpace = await createSpaceResponse.json() as SessionTargetSpace;
    spacesBefore.push(targetSpace);
  }
  const defaultMappingsBefore = spacesBefore
    .map(({ id, default_character_pack_id }) => [id, default_character_pack_id ?? null])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const archive = makeStoredZip([
    ["manifest.json", JSON.stringify({
      format: "airi-character-card",
      version: 1,
      createdAt: "2026-07-18T00:00:00.000Z",
      card: {
        path: "card.json",
        spec: "chara_card_v3",
      },
      resources: {
        displayModel: {
          path: sourceDisplayModelPath,
          format: "vrm",
          name: sourceDisplayModelName,
        },
      },
    })],
    ["card.json", JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: importedName,
        description: "使用本地 CC0 VRM 验证 AIRI 角色包导入边界。",
        personality: "会先核对证据再推进下一步。",
        scenario: "在角色工作室中检查本地模型，但不改动学习空间默认角色。",
        first_mes: "先确认模型来自本地受保护资产端点。",
        alternate_greetings: [],
        system_prompt: "AIRI_VRM_PROMPT_MUST_NOT_PERSIST",
        post_history_instructions: "AIRI_VRM_HISTORY_MUST_NOT_PERSIST",
        character_version: "1.0",
        creator_notes: "Synthetic source-pinned AIRI VRM E2E fixture",
        extensions: {
          display_model_source_url: remoteModelUrl,
        },
      },
    })],
    [sourceDisplayModelPath, vrmBytes],
  ]);
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));

  await page.goto("/characters");
  const importDisclosure = await openCharacterDisclosure(page, "导入已有角色（高级）");
  await expect(importDisclosure.getByText(/AIRI ZIP 会导入角色人格/)).toBeVisible();
  const runtimeModelResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith("/assets/model.vrm")
      && response.status() === 200,
  );
  const importResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/characters/import")
      && response.request().method() === "POST",
  );
  await importDisclosure.locator('input[type="file"][accept*=".zip"]').setInputFiles({
    name: `airi-v0.11.3-vrm-${runSuffix}.zip`,
    mimeType: "application/zip",
    buffer: archive,
  });
  const importResponse = await importResponsePromise;
  expect(importResponse.status()).toBe(201);
  const imported = await importResponse.json() as {
    id: string;
    asset_manifest: Record<string, unknown>;
    recipe: { avatar_model: string };
  };
  expect(imported.recipe.avatar_model).toBe("mira");
  expect(imported.asset_manifest).toMatchObject({
    model_path: "model.vrm",
    asset_paths: ["licenses/vrm-meta.json", "model.vrm"],
    source_filename: "Sendagaya-Shino.vrm",
    source_format: "airi-character-card",
    source_display_model_format: "vrm",
    source_display_model_name: sourceDisplayModelName,
    source_display_model_imported: true,
  });
  expect(JSON.stringify(imported)).not.toContain(remoteModelUrl);
  await expect(page).toHaveURL(new RegExp(`/characters/${imported.id}$`), { timeout: 60_000 });

  const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
  const provenance = readiness.getByTestId("airi-import-provenance");
  await expect(provenance).toContainText("包内声明的 VRM 已通过格式与内嵌元数据校验并导入");
  await expect(provenance).toContainText("该校验不证明使用或再分发授权，请自行确认模型许可");
  await expect(provenance).toContainText("不会自动替换任何学习空间");
  await expect(provenance).toContainText("需在上方明确选择空间并将当前角色设为默认角色");
  await expect(provenance).toContainText("vrm");
  await expect(provenance).toContainText(sourceDisplayModelName);
  const runtimeModelResponse = await runtimeModelResponsePromise;
  expect(new URL(runtimeModelResponse.url()).pathname).toBe(
    `/api/v1/characters/${imported.id}/assets/model.vrm`,
  );
  expect(runtimeModelResponse.headers()["content-type"]).toContain("model/gltf-binary");
  await expect(page.getByText(
    /Attached VRM · Sendagaya-Shino\.vrm 正在作为实际渲染源/,
  )).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-runtime-mode]").first()).toHaveAttribute(
    "data-runtime-mode",
    "ready",
    { timeout: 60_000 },
  );
  await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
    timeout: 60_000,
  });
  await expect(readiness).toContainText("VRM 0.x");

  const modelResponse = await page.request.get(
    `${apiBaseUrl}/api/v1/characters/${imported.id}/assets/model.vrm`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  expect(modelResponse.status()).toBe(200);
  expect(modelResponse.headers()["content-type"]).toContain("model/gltf-binary");
  expect(Buffer.compare(await modelResponse.body(), vrmBytes)).toBe(0);

  const sessionPostBodies: Array<Record<string, unknown>> = [];
  const recordSessionPost = (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/sessions")) {
      sessionPostBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  };
  page.on("request", recordSessionPost);
  await page.goto(`/spaces/${targetSpace.id}/call`);
  const sessionCharacterSelect = page.getByLabel("本次会话角色", { exact: true });
  const callRuntimeCanvas = page.getByLabel("VRM character canvas").locator("canvas");
  await expect(sessionCharacterSelect).toBeEnabled();
  await expect(sessionCharacterSelect).toHaveValue("");
  await expect(sessionCharacterSelect.getByRole("option", { name: importedName, exact: true }))
    .toHaveAttribute("value", imported.id);

  const previewModelResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET"
      && new URL(response.url()).pathname
        === `/api/v1/characters/${imported.id}/assets/model.vrm`,
  );
  await sessionCharacterSelect.selectOption(imported.id);
  const previewModelResponse = await previewModelResponsePromise;
  expect(previewModelResponse.status()).toBe(200);
  expect(previewModelResponse.headers()["content-type"]).toContain("model/gltf-binary");
  await expect(page.getByRole("heading", { name: targetSpace.name, exact: true }))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: importedName }))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-runtime-mode]").first()).toHaveAttribute(
    "data-runtime-mode",
    "ready",
    { timeout: 60_000 },
  );
  await expect(callRuntimeCanvas).toHaveAttribute("data-avatar-vrm-version", "VRM 0.x");
  expect(sessionPostBodies).toHaveLength(0);

  const firstSessionResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().endsWith("/api/v1/sessions"),
  );
  await page.getByPlaceholder(/输入消息/).fill(`使用临时 AIRI 角色开始会话 ${runSuffix}`);
  await page.getByRole("button", { name: "发送文本" }).click();
  const firstSessionResponse = await firstSessionResponsePromise;
  expect(firstSessionResponse.status()).toBe(201);
  const firstSession = await firstSessionResponse.json() as {
    id: string;
    character_pack_id: string | null;
  };
  expect(sessionPostBodies).toHaveLength(1);
  expect(sessionPostBodies[0]).toEqual({
    space_id: targetSpace.id,
    character_pack_id: imported.id,
  });
  expect(firstSession.character_pack_id).toBe(imported.id);
  const firstSessionGet = await page.request.get(
    `${apiBaseUrl}/api/v1/sessions/${firstSession.id}`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  expect(firstSessionGet.status()).toBe(200);
  expect((await firstSessionGet.json() as {
    session: { character_pack_id: string | null };
  }).session.character_pack_id).toBe(imported.id);
  await expect(sessionCharacterSelect).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  const restoreImportedSessionPromise = page.waitForResponse((response) =>
    response.request().method() === "GET"
      && response.url().endsWith(`/api/v1/sessions/${firstSession.id}`),
  );
  await page.goto(`/spaces/${targetSpace.id}/call?session=${firstSession.id}`);
  expect((await restoreImportedSessionPromise).status()).toBe(200);
  await expect(sessionCharacterSelect).toBeDisabled();
  await expect(sessionCharacterSelect).toHaveValue(imported.id);
  await expect(page.getByRole("heading", { name: targetSpace.name, exact: true }))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: importedName }))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-runtime-mode]").first()).toHaveAttribute(
    "data-runtime-mode",
    "ready",
    { timeout: 60_000 },
  );
  await expect(callRuntimeCanvas).toHaveAttribute("data-avatar-vrm-version", "VRM 0.x");
  expect(sessionPostBodies).toHaveLength(1);

  await page.getByRole("button", { name: "结束会话" }).click();
  await expect(sessionCharacterSelect).toBeEnabled();
  await sessionCharacterSelect.selectOption("");
  const secondSessionResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().endsWith("/api/v1/sessions"),
  );
  await page.getByPlaceholder(/输入消息/).fill(`恢复空间默认角色 ${runSuffix}`);
  await page.getByRole("button", { name: "发送文本" }).click();
  const secondSessionResponse = await secondSessionResponsePromise;
  expect(secondSessionResponse.status()).toBe(201);
  const secondSession = await secondSessionResponse.json() as {
    id: string;
    character_pack_id: string | null;
  };
  const expectedDefaultCharacterId = targetSpace.default_character_pack_id
    ?? "default-cool-companion";
  expect(secondSession.id).not.toBe(firstSession.id);
  expect(sessionPostBodies).toHaveLength(2);
  expect(sessionPostBodies[1]).toEqual({ space_id: targetSpace.id });
  expect(secondSession.character_pack_id).toBe(expectedDefaultCharacterId);

  const [closedSessionGet, secondSessionGet] = await Promise.all([
    page.request.get(`${apiBaseUrl}/api/v1/sessions/${firstSession.id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }),
    page.request.get(`${apiBaseUrl}/api/v1/sessions/${secondSession.id}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }),
  ]);
  expect(closedSessionGet.status()).toBe(200);
  expect(secondSessionGet.status()).toBe(200);
  const closedSession = (await closedSessionGet.json() as {
    session: { character_pack_id: string | null; state: string };
  }).session;
  expect(closedSession.state).toBe("closed");
  expect(closedSession.character_pack_id).toBe(imported.id);
  expect((await secondSessionGet.json() as {
    session: { character_pack_id: string | null };
  }).session.character_pack_id).toBe(expectedDefaultCharacterId);
  await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  const restoreSecondSessionPromise = page.waitForResponse((response) =>
    response.request().method() === "GET"
      && response.url().endsWith(`/api/v1/sessions/${secondSession.id}`),
  );
  await page.goto(`/spaces/${targetSpace.id}/call?session=${secondSession.id}`);
  expect((await restoreSecondSessionPromise).status()).toBe(200);
  await expect(sessionCharacterSelect).toBeDisabled();
  await expect(sessionCharacterSelect).toHaveValue(expectedDefaultCharacterId);
  page.off("request", recordSessionPost);

  const spacesAfterResponse = await page.request.get(`${apiBaseUrl}/api/v1/spaces`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(spacesAfterResponse.status()).toBe(200);
  const spacesAfter = await spacesAfterResponse.json() as Array<{
    id: string;
    default_character_pack_id?: string | null;
  }>;
  const defaultMappingsAfter = spacesAfter
    .map(({ id, default_character_pack_id }) => [id, default_character_pack_id ?? null])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  expect(defaultMappingsAfter).toEqual(defaultMappingsBefore);
  expect(browserRequests).not.toContain(remoteModelUrl);
  expect(browserRequests.some((url) => new URL(url).pathname === `/${sourceDisplayModelPath}`))
    .toBe(false);
  expect(browserRequests.some((url) =>
    new URL(url).pathname.endsWith(`/api/v1/characters/${imported.id}/assets/model.vrm`),
  )).toBe(true);
});

async function initializeAndUnlockVault(page: Page) {
  await page.goto("/vault");

  const statusLabels = page.locator(".status-badge");

  await expect(page.getByRole("form", { name: /^Vault (初始化|解锁)$/ })).toHaveCount(1);

  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.status()).toBe(200);
  const vaultStatus = await statusResponse.json() as { initialized?: unknown };
  let ownerToken: string | null = null;

  if (vaultStatus.initialized !== true) {
    await page.getByLabel("初始化主密码").fill(vaultPassword);
    const initResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/init") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "初始化 Vault" }).click();
    ownerToken = ((await (await initResponse).json()) as { owner_token?: string | null }).owner_token ?? null;
  } else {
    await page.getByLabel("解锁主密码").fill(vaultPassword);
    const unlockResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/vault/unlock") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "解锁" }).click();
    ownerToken = ((await (await unlockResponse).json()) as { owner_token?: string | null }).owner_token ?? null;
  }

  await expect(statusLabels.filter({ hasText: "Yes" })).toHaveCount(2);
  expect(ownerToken).toBeTruthy();
  return ownerToken as string;
}

async function authorizeFocusedBrowser(page: Page) {
  const statusResponse = await page.request.get(`${apiBaseUrl}/api/v1/vault/status`);
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json() as { initialized: boolean };
  const unlockResponse = await page.request.post(
    `${apiBaseUrl}/api/v1/vault/${status.initialized ? "unlock" : "init"}`,
    { data: { password: vaultPassword } },
  );
  expect(unlockResponse.status()).toBe(200);
  const ownerToken = (await unlockResponse.json() as { owner_token?: string }).owner_token;
  expect(ownerToken).toBeTruthy();
  await page.route("**/api/v1/**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        Authorization: `Bearer ${ownerToken}`,
      },
    });
  });
  return ownerToken as string;
}

function makeStoredZip(files: Array<[string, Buffer | string]>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [filename, content] of files) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function unlockVaultForBrowser(page: Page) {
  await page.goto("/vault");
  await page.getByLabel("解锁主密码").fill(vaultPassword);
  const unlockResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/vault/unlock") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "解锁" }).click();
  expect((await unlockResponse).status()).toBe(200);
  await expect(page.getByText("Vault 已解锁。")).toBeVisible();
}

async function openCharacterDisclosure(
  page: Page,
  name: "创建新角色" | "导入已有角色（高级）",
) {
  const disclosure = name === "创建新角色"
    ? page.locator("details#new-character")
    : page.locator("details").filter({ hasText: name });
  await disclosure.locator(":scope > summary").click();
  await expect(disclosure).toHaveJSProperty("open", true);
  return disclosure;
}

async function assertCharacterStudioOptionCounts(page: Page) {
  const shapeCard = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Body, Face, Hair, Outfit" }),
  });
  await expect(
    shapeCard.getByRole("group", { name: "Body Presets" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.body);
  await expect(
    shapeCard.getByRole("group", { name: "Camera Framing" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.framing);
  await expect(
    shapeCard.getByRole("group", { name: "Stage Background" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.background);
  await expect(
    shapeCard.getByRole("group", { name: "Face" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.face);
  await expect(
    shapeCard.getByRole("group", { name: "Hair" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.hair);
  await expect(
    shapeCard.getByRole("group", { name: "Outfit" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.outfit);
  await expect(
    shapeCard.getByRole("group", { name: "Accessories" }).getByRole("button"),
  ).toHaveCount(studioOptionCounts.accessories);
}

async function assertStageCompanionRecipe(page: Page, expectedName: string) {
  await expect(page.getByLabel("Name")).toHaveValue(expectedName);
  await expect(page.getByLabel("Description")).toHaveValue(/不是 AIRI 官方角色或官方资产/);
  await expect(page.getByLabel("Voice Provider")).toHaveValue("local-neural");
  await expect(page.getByLabel("Voice Model")).toHaveValue("qwen3-tts-0.6b-customvoice");
  await expect(page.getByLabel("Voice ID")).toHaveValue("Vivian");
  await expect(page.getByLabel(/^Voice Rate/)).toHaveValue("1.04");
  await expect(page.getByLabel("Accent")).toHaveValue("#58d8bd");
  await expect(page.getByText("VRMA 4/4", { exact: true })).toBeVisible();

  const selectedChoices = [
    ["Built-in avatar", /^Sendagaya Shino/],
    ["Body Presets", /^Mini Body/],
    ["Camera Framing", /^Portrait/],
    ["Stage Background", /^Midnight/],
    ["Face", /^Serene/],
    ["Hair", /^Hime Cut/],
    ["Outfit", /^Studio/],
    ["Persona Presets", /^Spark/],
    ["Relation", /^Partner/],
    ["Accessories", /^Headphones/],
    ["Accessories", /^Badge/],
  ] as const;

  for (const [groupName, optionName] of selectedChoices) {
    await expect(
      page.getByRole("group", { name: groupName }).getByRole("button", { name: optionName }),
    ).toHaveAttribute("aria-pressed", "true");
  }

  const runtimeCanvas = page.getByLabel("VRM character canvas").locator("canvas");
  const readiness = page.getByRole("region", { name: "Avatar Asset Readiness" });
  await expect(readiness).toHaveAttribute("data-capability-source", "runtime", {
    timeout: 60_000,
  });
  await expect(readiness).toContainText("VRM 0.x");
  await expect(readiness).toContainText("4 / 4 ready");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-vrm-version", "VRM 0.x");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-configured-count", "4");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-ready-count", "4");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-framing", "portrait", {
    timeout: 30_000,
  });
  const runtimeViewport = page.locator("[data-avatar-state]").first();
  await expect(runtimeViewport).toHaveAttribute("data-avatar-stage-background", "midnight");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-stage-background", "midnight");
  const midnightBackground = await runtimeViewport.evaluate(
    (element) => window.getComputedStyle(element).backgroundImage,
  );
  await expect(runtimeViewport).toHaveAttribute("data-ready", "true");
  await runtimeViewport.evaluate((element) => {
    const viewport = element as HTMLElement & {
      __stageBackgroundProbe?: {
        canvas: HTMLCanvasElement | null;
        leftReady: boolean;
        observer: MutationObserver;
      };
    };
    const probe = {
      canvas: viewport.querySelector("canvas"),
      leftReady: false,
      observer: new MutationObserver(() => {
        if (viewport.dataset.ready !== "true") {
          probe.leftReady = true;
        }
      }),
    };
    probe.observer.observe(viewport, {
      attributes: true,
      attributeFilter: ["data-ready"],
    });
    viewport.__stageBackgroundProbe = probe;
  });
  let modelRequestsDuringBackgroundSwitch = 0;
  const backgroundRequestListener = (request: Request) => {
    if (/\/assets\/model\.vrm(?:\?|$)/i.test(request.url()) || /Sendagaya[-_ ]Shino\.vrm/i.test(request.url())) {
      modelRequestsDuringBackgroundSwitch += 1;
    }
  };
  page.on("request", backgroundRequestListener);
  await page.getByRole("group", { name: "Stage Background" }).getByRole("button", { name: /^Study/ }).click();
  await expect(runtimeViewport).toHaveAttribute("data-avatar-stage-background", "study");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-stage-background", "study");
  const studyBackground = await runtimeViewport.evaluate(
    (element) => window.getComputedStyle(element).backgroundImage,
  );
  expect(studyBackground).not.toBe(midnightBackground);
  await page.getByRole("group", { name: "Stage Background" }).getByRole("button", { name: /^Neutral/ }).click();
  await expect(runtimeViewport).toHaveAttribute("data-avatar-stage-background", "neutral");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-stage-background", "neutral");
  await expect
    .poll(() => runtimeViewport.evaluate((element) => window.getComputedStyle(element).backgroundImage))
    .not.toBe(midnightBackground);
  const neutralBackground = await runtimeViewport.evaluate(
    (element) => window.getComputedStyle(element).backgroundImage,
  );
  expect(neutralBackground).not.toBe(studyBackground);
  await page.getByRole("group", { name: "Stage Background" }).getByRole("button", { name: /^Midnight/ }).click();
  await expect(runtimeViewport).toHaveAttribute("data-avatar-stage-background", "midnight");
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-stage-background", "midnight");
  await expect
    .poll(() => runtimeViewport.evaluate((element) => window.getComputedStyle(element).backgroundImage))
    .toBe(midnightBackground);
  const backgroundSwitchProbe = await runtimeViewport.evaluate((element) => {
    const viewport = element as HTMLElement & {
      __stageBackgroundProbe?: {
        canvas: HTMLCanvasElement | null;
        leftReady: boolean;
        observer: MutationObserver;
      };
    };
    const probe = viewport.__stageBackgroundProbe;
    if (!probe) {
      throw new Error("Stage background probe was not installed.");
    }
    probe.observer.disconnect();
    delete viewport.__stageBackgroundProbe;
    return {
      canvasStayedConnected: probe.canvas?.isConnected ?? false,
      leftReady: probe.leftReady,
      sameCanvas: probe.canvas === viewport.querySelector("canvas"),
    };
  });
  page.off("request", backgroundRequestListener);
  expect(modelRequestsDuringBackgroundSwitch).toBe(0);
  expect(backgroundSwitchProbe).toEqual({
    canvasStayedConnected: true,
    leftReady: false,
    sameCanvas: true,
  });
  await expectModelAwareCameraTelemetry(runtimeCanvas, "portrait");
  const portraitOccupancy = Number(await runtimeCanvas.getAttribute("data-camera-occupancy"));
  const portraitVerticalOccupancy = Number(await runtimeCanvas.getAttribute("data-camera-vertical-occupancy"));
  const portraitDistance = Number(await runtimeCanvas.getAttribute("data-camera-distance"));
  let modelRequestsDuringRefit = 0;
  const modelRequestListener = (request: Request) => {
    if (/\/assets\/model\.vrm(?:\?|$)/i.test(request.url()) || /Sendagaya[-_ ]Shino\.vrm/i.test(request.url())) {
      modelRequestsDuringRefit += 1;
    }
  };
  page.on("request", modelRequestListener);
  await page.getByRole("group", { name: "Camera Framing" }).getByRole("button", { name: /^Full Body/ }).click();
  await expectModelAwareCameraTelemetry(runtimeCanvas, "full_body");
  const fullBodyVerticalOccupancy = Number(await runtimeCanvas.getAttribute("data-camera-vertical-occupancy"));
  const fullBodyDistance = Number(await runtimeCanvas.getAttribute("data-camera-distance"));
  expect(portraitVerticalOccupancy).toBeGreaterThan(fullBodyVerticalOccupancy);
  expect(portraitDistance).toBeLessThan(fullBodyDistance);
  expect(portraitOccupancy).toBeGreaterThan(0);
  await page.getByRole("group", { name: "Camera Framing" }).getByRole("button", { name: /^Portrait/ }).click();
  await expectModelAwareCameraTelemetry(runtimeCanvas, "portrait");
  const stage = page.getByLabel("VRM character canvas");
  const stableTarget = await runtimeCanvas.getAttribute("data-camera-target");
  const stableFitSource = await runtimeCanvas.getAttribute("data-camera-fit-source");
  const stableDistance = Number(await runtimeCanvas.getAttribute("data-camera-distance"));
  const stableFrameSize = (await runtimeCanvas.getAttribute("data-camera-frame-size"))!.split(",").map(Number);
  const originalStageRect = await stage.boundingBox();
  expect(originalStageRect).not.toBeNull();
  await stage.evaluate((element) => {
    element.setAttribute("data-e2e-original-style", element.getAttribute("style") ?? "");
    (element as HTMLElement).style.width = "140px";
    (element as HTMLElement).style.height = "500px";
  });
  await expect
    .poll(async () => Number(await runtimeCanvas.getAttribute("data-camera-distance")), { timeout: 10_000 })
    .toBeGreaterThan(stableDistance);
  const narrowFrameSize = (await runtimeCanvas.getAttribute("data-camera-frame-size"))!.split(",").map(Number);
  expect(
    narrowFrameSize[0] !== stableFrameSize[0]
      || Number(await runtimeCanvas.getAttribute("data-camera-distance")) > stableDistance,
  ).toBeTruthy();
  await expect(runtimeCanvas).toHaveAttribute("data-camera-target", stableTarget ?? "");
  await expect(runtimeCanvas).toHaveAttribute("data-camera-fit-source", stableFitSource ?? "");
  await stage.evaluate((element, originalRectText) => {
    const originalRect = originalRectText.split(",").map(Number);
    if (originalRect?.length === 2 && originalRect.every((value) => Number.isFinite(value))) {
      (element as HTMLElement).style.width = `${originalRect[0]}px`;
      (element as HTMLElement).style.height = `${originalRect[1]}px`;
    }
  }, `${originalStageRect?.width ?? 0},${originalStageRect?.height ?? 0}`);
  await expect
    .poll(async () => Number(await runtimeCanvas.getAttribute("data-camera-distance")), { timeout: 10_000 })
    .toBeCloseTo(stableDistance, 3);
  const restoredFrameSize = (await runtimeCanvas.getAttribute("data-camera-frame-size"))!.split(",").map(Number);
  expect(restoredFrameSize[0]).toBeCloseTo(stableFrameSize[0], 3);
  await stage.evaluate((element) => {
    (element as HTMLElement).setAttribute("style", element.getAttribute("data-e2e-original-style") ?? "");
    element.removeAttribute("data-e2e-original-style");
  });
  await expect
    .poll(async () => Number(await runtimeCanvas.getAttribute("data-camera-distance")), { timeout: 10_000 })
    .toBeCloseTo(stableDistance, 3);
  await expectModelAwareCameraTelemetry(runtimeCanvas, "portrait");
  page.off("request", modelRequestListener);
  expect(modelRequestsDuringRefit).toBe(0);
  const previewStateGroup = page.getByRole("group", { name: "Preview State" });
  const motionStates = [
    ["Idle", "idle"],
    ["Listening", "listening"],
    ["Thinking", "thinking"],
    ["Speaking", "speaking"],
  ] as const;
  for (const [label, motionState] of motionStates) {
    await previewStateGroup.getByRole("button", { name: label, exact: true }).click();
    await expectVrmaStatePose(runtimeCanvas, motionState);
  }
  await previewStateGroup.getByRole("button", { name: "Idle", exact: true }).click();
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-state", "idle");
}

async function expectModelAwareCameraTelemetry(
  canvas: ReturnType<Page["locator"]>,
  framing: "full_body" | "portrait",
) {
  await expect(canvas).toHaveAttribute("data-avatar-framing", framing);
  await expect(canvas).toHaveAttribute("data-camera-fit-source", /^(humanoid|visible-bounds)$/);
  await expect(canvas).toHaveAttribute("data-avatar-bounds-size", /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-frame-size", /^\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-target", /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-distance", /^\d+(?:\.\d+)?$/);
  await expect(canvas).toHaveAttribute("data-camera-occupancy", /^0(?:\.\d+)?$|^1(?:\.0+)?$|^0?\.\d+$/);
  await expect(canvas).toHaveAttribute("data-camera-vertical-occupancy", /^0(?:\.\d+)?$|^1(?:\.0+)?$|^0?\.\d+$/);
  const distance = Number(await canvas.getAttribute("data-camera-distance"));
  const occupancy = Number(await canvas.getAttribute("data-camera-occupancy"));
  const verticalOccupancy = Number(await canvas.getAttribute("data-camera-vertical-occupancy"));
  const bounds = (await canvas.getAttribute("data-avatar-bounds-size"))!.split(",").map(Number);
  const frameSize = (await canvas.getAttribute("data-camera-frame-size"))!.split(",").map(Number);
  expect(bounds).toHaveLength(3);
  expect(frameSize).toHaveLength(3);
  expect(bounds.every((value) => Number.isFinite(value) && value > 0)).toBeTruthy();
  expect(frameSize.every((value) => Number.isFinite(value) && value > 0)).toBeTruthy();
  expect(Number.isFinite(distance) && distance > 0).toBeTruthy();
  expect(Number.isFinite(occupancy) && occupancy > 0 && occupancy <= 1).toBeTruthy();
  expect(Number.isFinite(verticalOccupancy) && verticalOccupancy > 0 && verticalOccupancy <= 1).toBeTruthy();
}

async function expectVrmaStatePose(
  runtimeCanvas: ReturnType<Page["locator"]>,
  state: "idle" | "listening" | "thinking" | "speaking",
) {
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-mode", "vrma", {
    timeout: 60_000,
  });
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-requested-state", state);
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-state", state);
  await expect(runtimeCanvas).toHaveAttribute("data-avatar-motion-action-running", "true");
  await expect
    .poll(async () => Number.parseFloat(
      (await runtimeCanvas.getAttribute("data-avatar-motion-effective-weight")) ?? "0",
    ), { timeout: 10_000 })
    .toBeGreaterThan(0.8);
  await expect
    .poll(async () => runtimeCanvas.getAttribute("data-avatar-motion-time"), {
      timeout: 10_000,
    })
    .not.toBeNull();
  const firstTime = await runtimeCanvas.getAttribute("data-avatar-motion-time");
  await expect
    .poll(async () => runtimeCanvas.getAttribute("data-avatar-motion-time"), {
      timeout: 5_000,
    })
    .not.toBe(firstTime);
  await expectAnimatedBonePose(runtimeCanvas);
}

async function expectAnimatedBonePose(runtimeCanvas: ReturnType<Page["locator"]>) {
  await expect
    .poll(async () => (await runtimeCanvas.getAttribute("data-avatar-motion-bone-sample")) ?? "", {
      timeout: 10_000,
    })
    .not.toBe("");
  const firstPose = await runtimeCanvas.getAttribute("data-avatar-motion-bone-sample");
  await expect
    .poll(async () => runtimeCanvas.getAttribute("data-avatar-motion-bone-sample"), {
      timeout: 5_000,
    })
    .not.toBe(firstPose);
}

async function getLocalMetricEvents(page: Page, ownerToken: string) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/metrics/local/events?limit=500`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
    },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{
    items: Array<{
      event?: unknown;
      payload?: { session_id?: unknown };
    }>;
  }>;
}

async function getSessionTranscript(page: Page, ownerToken: string, sessionId: string) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{
    session: { space_id: string };
    turns: Array<{ role: "user" | "assistant"; display_text: string }>;
  }>;
}

function watchSessionPosts(page: Page) {
  const requests: string[] = [];
  const handler = (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/sessions")) {
      requests.push(request.url());
    }
  };
  page.on("request", handler);
  return { requests, stop: () => page.off("request", handler) };
}

async function navigateViaSidebar(page: Page, label: string) {
  const navigation = page.getByRole("navigation");
  const target = navigation.getByRole("link", { name: new RegExp(label) });
  const visibleTarget = target.filter({ visible: true }).first();
  if (await visibleTarget.count()) {
    await visibleTarget.click();
    return;
  }
  await navigation.getByText("本地与服务设置", { exact: true }).click();
  await target.filter({ visible: true }).first().click();
}

async function openSessionReview(page: Page, href: string) {
  await navigateViaSidebar(page, "会话复盘");
  const reviewLink = page
    .locator(`a[href="${href}"]`)
    .filter({ hasText: "查看复盘" });
  await expect(reviewLink).toBeVisible({ timeout: 60_000 });
  await reviewLink.click();
  await expect(page).toHaveURL(
    new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    { timeout: 60_000 },
  );
}
