import type { Locator, Page } from "@playwright/test";

export type Scope = Page | Locator;

export async function pick(
  scope: Scope,
  label: string,
  option: string | { label: string },
) {
  const control = scope.getByRole("combobox", { name: label, exact: true });
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") {
    await control.selectOption(option);
    return;
  }
  // Base UI Select trigger renders as button[role="combobox"] and portals options to document.body
  const page = "page" in scope && typeof scope.page === "function" ? scope.page() : (scope as Page);
  await control.click();
  await page.getByRole("option").first().waitFor({ state: "visible" });
  if (typeof option === "string") {
    const byValue = page.locator(`[role="option"][data-value="${option}"]`).first();
    if ((await byValue.count()) > 0) {
      await byValue.click();
    } else {
      await page.getByRole("option", { name: option, exact: true }).click();
    }
  } else {
    await page.getByRole("option", { name: option.label, exact: true }).click();
  }
}
