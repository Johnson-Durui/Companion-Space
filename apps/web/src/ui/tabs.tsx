import type { ReactNode } from "react";
import { Link } from "react-router";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import clsx from "clsx";

export interface TabItem {
  value: string;
  label: string;
  badge?: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  items: TabItem[];
  className?: string;
}

export function Tabs({ value, defaultValue, onValueChange, items, className }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={(next) => {
        if (next != null) onValueChange?.(String(next));
      }}
      className={clsx("grid gap-4", className)}
    >
      <BaseTabs.List className="flex items-center gap-1 overflow-x-auto border-b border-line-subtle">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={clsx(
              "relative inline-flex min-h-10 shrink-0 items-center gap-1.5 px-3.5 text-ui font-medium text-fg-secondary transition-colors duration-fast ease-out",
              "hover:text-fg-primary aria-[selected=true]:font-semibold aria-[selected=true]:text-accent-strong data-[active]:font-semibold data-[active]:text-accent-strong",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent aria-[selected=true]:after:bg-accent data-[active]:after:bg-accent",
            )}
          >
            <span>{item.label}</span>
            {item.badge}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {items.map((item) => (
        <BaseTabs.Panel key={item.value} value={item.value} className="outline-none">
          {item.content}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}

export interface RouteTabEntry {
  to: string;
  label: string;
  active: boolean;
  badge?: ReactNode;
}

export interface RouteTabsProps {
  items: RouteTabEntry[];
  "aria-label": string;
  className?: string;
}

export function RouteTabs({ items, "aria-label": ariaLabel, className }: RouteTabsProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className={clsx("flex items-center gap-1 overflow-x-auto border-b border-line-subtle", className)}
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? "page" : undefined}
          className={clsx(
            "relative inline-flex min-h-10 shrink-0 items-center gap-1.5 px-3.5 text-ui transition-colors duration-fast ease-out",
            item.active
              ? "font-semibold text-accent-strong"
              : "font-medium text-fg-secondary hover:text-fg-primary",
          )}
        >
          <span>{item.label}</span>
          {item.badge}
          {item.active ? (
            <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
