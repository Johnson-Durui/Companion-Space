import { expect, test } from "@playwright/test";

test.use({ trace: "off", video: "off" });

test.describe("Vault flow", () => {
  test("waits for status and shows only the initialization action", async ({ page }) => {
    let releaseStatus!: () => void;
    let statusRequested!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const statusRequest = new Promise<void>((resolve) => {
      statusRequested = resolve;
    });

    await page.route("**/api/v1/vault/status", async (route) => {
      statusRequested();
      await statusGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: false, unlocked: false }),
      });
    });

    await page.goto("/vault");
    await statusRequest;
    await expect(page.getByRole("form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "初始化 Vault" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "解锁 Vault" })).toHaveCount(0);

    releaseStatus();

    await expect(page.getByRole("form", { name: "Vault 初始化" })).toBeVisible();
    await expect(page.getByLabel("初始化主密码")).toBeFocused();
    await expect(page.getByRole("button", { name: "初始化 Vault" })).toBeDisabled();
    await expect(page.getByLabel("解锁主密码")).toHaveCount(0);
  });

  test("guides a locked initialized Vault through a friendly retry", async ({ page }) => {
    let unlocked = false;
    let unlockAttempts = 0;
    let initRequests = 0;
    let releaseUnlock!: () => void;
    const unlockGate = new Promise<void>((resolve) => {
      releaseUnlock = resolve;
    });

    await page.route("**/api/v1/vault/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: true, unlocked }),
      });
    });
    await page.route("**/api/v1/vault/init", async (route) => {
      initRequests += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Vault already initialized",
          code: "vault_already_initialized",
        }),
      });
    });
    await page.route("**/api/v1/vault/unlock", async (route) => {
      unlockAttempts += 1;
      const body = route.request().postDataJSON() as { password?: unknown };
      if (unlockAttempts === 1) {
        expect(body.password).toBe("wrong-password");
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Invalid vault password",
            code: "vault_invalid_password",
          }),
        });
        return;
      }

      expect(body.password).toBe("correct-password");
      await unlockGate;
      unlocked = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          initialized: true,
          unlocked: true,
          owner_token: "owner-token-for-vault-flow",
        }),
      });
    });

    await page.goto("/vault");

    const unlockForm = page.getByRole("form", { name: "Vault 解锁" });
    const passwordInput = page.getByLabel("解锁主密码");
    await expect(unlockForm).toBeVisible();
    await expect(passwordInput).toBeFocused();
    await expect(page.getByLabel("初始化主密码")).toHaveCount(0);
    await expect(page.getByText("高级操作：重置 Vault")).toHaveCount(0);

    await passwordInput.fill("wrong-password");
    await page.getByRole("button", { name: "解锁 Vault" }).click();
    const errorCallout = page.locator(".error-callout");
    await expect(errorCallout).toHaveText("主密码不正确，请检查后重试。");
    await expect(passwordInput).toHaveValue("wrong-password");

    await passwordInput.fill("correct-password");
    await expect(errorCallout).toHaveCount(0);
    await page.getByRole("button", { name: "解锁 Vault" }).click();
    await expect(unlockForm).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "正在解锁..." })).toBeDisabled();

    releaseUnlock();

    await expect(page.getByText("Vault 已解锁。")).toBeVisible();
    await expect(page.getByText("Vault 已就绪，可以进入 Companion Space。")).toBeVisible();
    await expect(page.getByRole("link", { name: "进入 Companion Space" })).toHaveAttribute("href", "/");
    await expect(unlockForm).toHaveCount(0);
    await expect(errorCallout).toHaveCount(0);
    expect(initRequests).toBe(0);
    expect(unlockAttempts).toBe(2);
  });

  test("requires a fresh browser unlock when only the server remains unlocked", async ({ page }) => {
    await page.route("**/api/v1/vault/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: true, unlocked: true }),
      });
    });

    await page.goto("/vault");

    await expect(page.getByRole("form", { name: "Vault 解锁" })).toBeVisible();
    await expect(page.getByText("服务端仍保持解锁，但当前浏览器会话已失效，请重新输入主密码。")).toBeVisible();
    await expect(page.getByRole("link", { name: "进入 Companion Space" })).toHaveCount(0);
    await expect(page.getByText("高级操作：重置 Vault")).toHaveCount(0);
  });

  test("keeps the newest status when another tab locks during an older refresh", async ({ context, page }) => {
    let serverUnlocked = false;
    let pageStatusRequests = 0;
    let releaseStaleStatus!: () => void;
    let markStaleStatusStarted!: () => void;
    const staleStatusGate = new Promise<void>((resolve) => {
      releaseStaleStatus = resolve;
    });
    const staleStatusStarted = new Promise<void>((resolve) => {
      markStaleStatusStarted = resolve;
    });

    await page.route("**/api/v1/vault/status", async (route) => {
      pageStatusRequests += 1;
      if (pageStatusRequests === 2) {
        markStaleStatusStarted();
        await staleStatusGate;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ initialized: true, unlocked: true }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: true, unlocked: serverUnlocked }),
      });
    });
    await page.route("**/api/v1/vault/unlock", async (route) => {
      serverUnlocked = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          initialized: true,
          unlocked: true,
          owner_token: "shared-owner-token",
        }),
      });
    });
    await page.goto("/vault");
    await page.getByLabel("解锁主密码").fill("correct-password");
    await page.getByRole("button", { name: "解锁 Vault" }).click();
    await staleStatusStarted;

    const otherTab = await context.newPage();
    await otherTab.route("**/api/v1/vault/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: true, unlocked: serverUnlocked }),
      });
    });
    await otherTab.route("**/api/v1/vault/unlock", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          initialized: true,
          unlocked: true,
          owner_token: "other-tab-owner-token",
        }),
      });
    });
    await otherTab.route("**/api/v1/vault/lock", async (route) => {
      serverUnlocked = false;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: true, unlocked: false }),
      });
    });
    await otherTab.goto("/vault");
    await otherTab.getByLabel("解锁主密码").fill("correct-password");
    await otherTab.getByRole("button", { name: "解锁 Vault" }).click();
    await expect(otherTab.getByRole("button", { name: "立即锁定" })).toBeEnabled();
    await otherTab.getByRole("button", { name: "立即锁定" }).click();

    await expect(page.getByRole("form", { name: "Vault 解锁" })).toBeVisible();
    releaseStaleStatus();

    await expect(page.getByRole("link", { name: "进入 Companion Space" })).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Vault 解锁" })).toBeVisible();
    await expect(page.getByText("Vault 已经初始化，只需输入原主密码。")).toBeVisible();
    await expect(page.getByText("服务端仍保持解锁，但当前浏览器会话已失效，请重新输入主密码。")).toHaveCount(0);
    expect(pageStatusRequests).toBe(3);
  });

  test("shows initialization when another tab resets the Vault", async ({ context, page }) => {
    let initialized = true;
    let unlocked = false;

    await context.route("**/api/v1/vault/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized, unlocked }),
      });
    });
    await context.route("**/api/v1/vault/unlock", async (route) => {
      unlocked = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          initialized: true,
          unlocked: true,
          owner_token: "shared-owner-token",
        }),
      });
    });
    await context.route("**/api/v1/vault/reset", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ password: "correct-password" });
      initialized = false;
      unlocked = false;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: false, unlocked: false }),
      });
    });

    await page.goto("/vault");
    await page.getByLabel("解锁主密码").fill("correct-password");
    await page.getByRole("button", { name: "解锁 Vault" }).click();
    await expect(page.getByRole("link", { name: "进入 Companion Space" })).toBeVisible();

    const otherTab = await context.newPage();
    await otherTab.goto("/vault");
    await otherTab.getByLabel("解锁主密码").fill("correct-password");
    await otherTab.getByRole("button", { name: "解锁 Vault" }).click();
    await otherTab.getByText("高级操作：重置 Vault").click();
    await otherTab.getByLabel("当前主密码").fill("correct-password");
    await otherTab.getByRole("button", { name: "重置 Vault", exact: true }).click();

    await expect(page.getByRole("form", { name: "Vault 初始化" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Vault 解锁" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "进入 Companion Space" })).toHaveCount(0);
  });
});
