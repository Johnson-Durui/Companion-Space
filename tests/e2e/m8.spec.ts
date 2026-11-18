import { expect, test } from "@playwright/test";
import t from "../../apps/web/src/locales/zh-CN.json";

test("the prerecorded sample accepts a choice and reaches its recap without model calls", async ({ page }) => {
  const sockets: string[] = [];
  const writes: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    if (request.method() === "POST" && !request.url().endsWith("/api/v2/session/bootstrap")) writes.push(request.url());
  });
  await page.clock.install();
  await page.goto("/welcome");
  await page.getByRole("link", { name: t.sample.open }).click();
  await expect(page.getByText(t.sample.recording, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: t.history.play, exact: true }).click();
  const option = page.getByRole("button", { name: /^B\./ });
  for (let step = 0; step < 30 && !await option.isVisible(); step += 1) {
    await page.clock.runFor(8_000);
  }
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator(".lesson-question [aria-live=polite] p").first()).not.toBeEmpty();
  const advance = page.getByRole("button", { name: t.sample.continue });
  const recap = page.getByRole("heading", { name: t.classroom.recap });
  for (let step = 0; step < 90 && !await recap.isVisible(); step += 1) {
    if (await advance.isVisible()) await advance.click();
    await page.clock.runFor(8_000);
  }
  await expect(recap).toBeVisible();
  expect(sockets).toEqual([]);
  expect(writes).toEqual([]);
});
