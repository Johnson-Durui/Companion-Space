import type { Locator, Page } from "@playwright/test";

export type Scope = Page | Locator;

export async function pick(
  scope: Scope,
  label: string,
  option: string | { label: string },
) {
  await scope.getByRole("combobox", { name: label, exact: true }).selectOption(option);
}
