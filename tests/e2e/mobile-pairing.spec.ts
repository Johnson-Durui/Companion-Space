import { expect, test } from "@playwright/test";

const pairingCode = "48273106";

function installSettingsRoutes(
  page: import("@playwright/test").Page,
  options: { localOwnerForbidden?: boolean } = {},
) {
  return page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/vault/status") {
      await route.fulfill({ json: { initialized: true, unlocked: true } });
      return;
    }
    if (path === "/api/v1/vault/preferences") {
      await route.fulfill({
        json: { adult_relationships_enabled: false, adult_age_confirmed_at: null },
      });
      return;
    }
    if (path === "/api/v1/spaces" || path === "/api/v1/providers/connections") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/v1/characters") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (path === "/api/v1/metrics/local/summary") {
      await route.fulfill({ status: 503, json: { detail: "Metrics unavailable in focused test" } });
      return;
    }
    if (path === "/api/v1/mobile/devices" && request.method() === "GET") {
      if (options.localOwnerForbidden) {
        await route.fulfill({ status: 403, json: { detail: "Local owner session required" } });
        return;
      }
      await route.fulfill({
        json: [
          {
            id: "device-android",
            name: "Pixel 10",
            refresh_expires_at: "2026-09-12T08:00:00Z",
            created_at: "2026-08-12T08:00:00Z",
            last_seen_at: "2026-08-12T09:00:00Z",
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/mobile/pairing-challenges" && request.method() === "POST") {
      if (options.localOwnerForbidden) {
        await route.fulfill({ status: 403, json: { detail: "Local owner session required" } });
        return;
      }
      await route.fulfill({
        json: {
          challenge_id: "challenge-settings-1",
          code: pairingCode,
          expires_at: "2026-08-12T10:10:00Z",
          attempts_allowed: 5,
        },
      });
      return;
    }
    if (path === "/api/v1/mobile/devices/device-android" && request.method() === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 418, json: { detail: `Unexpected request: ${request.method()} ${path}` } });
  });
}

test.describe("desktop mobile-device management", () => {
  test("generates an ephemeral pairing code, lists devices, and revokes after confirmation", async ({ page }) => {
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    await installSettingsRoutes(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "移动设备" })).toBeVisible();
    await expect(page.getByText("Pixel 10", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "生成一次性 8 位配对码" }).click();
    await expect(page.getByTestId("mobile-pairing-code")).toHaveText(pairingCode);
    await expect(page.getByText("5 次（新生成）", { exact: true })).toBeVisible();

    let copiedText = "";
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => { (window as typeof window & { __copied?: string }).__copied = value; } },
      });
    });
    await page.getByTestId("copy-mobile-pairing-code").click();
    copiedText = await page.evaluate(() => (window as typeof window & { __copied?: string }).__copied ?? "");
    expect(copiedText).toBe(pairingCode);
    await expect(page.getByTestId("copy-mobile-pairing-code")).toHaveText("已复制配对码");

    expect(page.url()).not.toContain(pairingCode);
    expect(requestedUrls.every((url) => !url.includes(pairingCode))).toBe(true);
    const storedValues = await page.evaluate(() => Object.values(localStorage));
    expect(storedValues.every((value) => !value.includes(pairingCode))).toBe(true);
    expect(storedValues.every((value) => !value.includes(copiedText))).toBe(true);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "撤销设备 Pixel 10" }).click();
    await expect(page.getByText("已撤销“Pixel 10”。", { exact: true })).toBeVisible();
    await expect(page.getByText("Pixel 10", { exact: true })).toHaveCount(0);
  });

  test("explains that a mobile access token cannot manage paired devices", async ({ page }) => {
    await installSettingsRoutes(page, { localOwnerForbidden: true });

    await page.goto("/settings");
    const localOwnerAlert = page.getByRole("alert").filter({
      hasText: "只有已解锁 Vault 的本机浏览器才能管理移动设备",
    });
    await expect(localOwnerAlert).toBeVisible();

    await page.getByRole("button", { name: "生成一次性 8 位配对码" }).click();
    await expect(localOwnerAlert).toBeVisible();
    await expect(page.getByTestId("mobile-pairing-code")).toHaveCount(0);
  });
});
