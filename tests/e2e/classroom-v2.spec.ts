import { expect, test } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 8100}/api/v1`;
const password = "m7-playwright-pass";

test("cookie session, structured classroom, source excerpt and FSRS review work without keys", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const status = await page.request.get(`${api}/vault/status`);
  const initialized = (await status.json() as { initialized: boolean }).initialized;
  const operation = initialized ? "unlock" : "init";
  const bootstrap = await page.request.post(`${api}/vault/${operation}`, { data: { password } });
  expect(bootstrap.ok()).toBeTruthy();
  const { owner_token } = await bootstrap.json() as { owner_token: string };
  expect(owner_token).toBeTruthy();
  const headers = { Authorization: `Bearer ${owner_token}` };
  const response = await page.request.post(`${api}/spaces`, {
    headers,
    data: { name: "算法研习室", topic: "二分查找", goal: "理解闭区间边界" },
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json() as { id: string };
  const source = await page.request.post(`${api}/spaces/${id}/materials/note`, {
    headers,
    data: { title: "算法讲义", content: "二分查找维护闭区间 [L, R]。当 L 等于 R 时仍需检查最后一个元素。每次比较后根据有序性收缩区间。" },
  });
  expect(source.ok()).toBeTruthy();
  await page.context().clearCookies();

  await page.goto("/vault");
  await page.getByLabel("解锁主密码").fill(password);
  const unlocked = page.waitForResponse((item) => item.url().endsWith("/vault/unlock") && item.request().method() === "POST");
  await page.getByRole("button", { name: "解锁 Vault", exact: true }).click();
  const unlockResponse = await unlocked;
  expect(unlockResponse.ok()).toBeTruthy();
  expect((await unlockResponse.json() as { owner_token?: unknown }).owner_token).toBeNull();
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "companion_owner_session");
  expect(cookie?.httpOnly).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Vault 已解锁" })).toBeVisible();

  await page.goto(`/spaces/${id}/call`);
  const board = page.getByRole("region", { name: "互动黑板" });
  await page.getByText("导师与声线", { exact: true }).click();
  await page.getByLabel("本次会话角色").selectOption({ label: "澄羽" });
  await expect(page.getByLabel("导师形象")).toBeVisible();
  await page.getByLabel("导师形象").selectOption("portrait");
  await expect(page.locator("[data-runtime-kind='portrait_2d']")).toBeVisible();
  await page.getByLabel("导师形象").selectOption("vrm");
  await page.getByText("导师与声线", { exact: true }).click();
  await board.getByRole("button", { name: "开始互动课堂" }).click();
  await expect(board.locator(".katex").first()).toBeVisible();
  await expect(board.locator("[data-board-kind='concept_sheet']")).toBeVisible();
  await board.getByText("算法讲义", { exact: false }).first().click();
  await expect(board.getByText("当 L 等于 R 时仍需检查最后一个元素", { exact: false })).toBeVisible();

  await page.reload();
  await expect(board.locator("[data-board-kind='concept_sheet']")).toBeVisible();
  await board.getByRole("button", { name: "进入推演" }).click();
  await expect(board.locator("[data-board-kind='step_sandbox']")).toBeVisible();
  await board.getByLabel("查找目标").fill("31");
  await board.getByRole("button", { name: "重新推演" }).click();
  await expect(board.getByText("1 / 2")).toBeVisible();
  await board.getByLabel("查找目标").fill("23");
  await board.getByRole("button", { name: "重新推演" }).click();
  await expect(board.getByText("1 / 3")).toBeVisible();
  const asked = page.waitForResponse((item) => item.url().endsWith("/classroom/events") && item.request().postDataJSON()?.type === "ask");
  await board.getByRole("button", { name: "索引 3，值 17" }).click();
  expect((await asked).ok()).toBeTruthy();
  await board.getByRole("button", { name: "下一步" }).click();
  await expect(board.getByText("2 / 3")).toBeVisible();
  await board.getByRole("button", { name: "下一步" }).click();
  await expect(board.getByText("3 / 3")).toBeVisible();
  await board.getByRole("button", { name: "继续教学" }).click();
  await expect(board.getByLabel("可追问的图谱节点")).toBeVisible();
  await board.getByRole("button", { name: "进入随堂测验" }).click();
  const answers = board.getByLabel("随堂测验答案").getByRole("button");
  await answers.first().click();
  await expect(board.locator("[data-correct='false']")).toBeVisible();
  await answers.nth(1).click();
  await expect(board.locator("[data-correct='true']")).toBeVisible();
  await expect(page.getByText("当前没有可打断的回复或演示。", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("classroom-desktop.png") });

  await board.getByRole("button", { name: "提炼复习闪卡" }).click();
  await expect(board.getByText(/已提炼 \d+ 张复习卡/)).toBeVisible();
  await board.getByRole("link", { name: "打开记忆复盘" }).click();
  await page.getByRole("button", { name: "确认加入复习" }).first().click();
  const card = page.getByRole("article", { name: "当前到期闪卡" });
  await card.getByRole("button", { name: "查看答案" }).click();
  await card.getByRole("button", { name: "记得", exact: true }).click();
  await expect(page.getByText(/下次复习/).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await expect(board.locator("[data-board-kind='checkpoint_quiz']")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByText("导师与声线", { exact: true }).click();
  await page.getByLabel("导师形象").selectOption("portrait");
  await expect(page.locator("[data-runtime-kind='portrait_2d']")).toBeVisible();
  await page.getByText("导师与声线", { exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("classroom-phone.png"), fullPage: true });
});
