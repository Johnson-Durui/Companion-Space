import type { ReactNode } from "react";
import { Link } from "react-router";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import clsx from "clsx";

export interface TabItem {
  value: string;
  label: string;
  icon?: ReactNode;
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
            {item.icon}
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
  icon?: ReactNode;
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
      className={clsx(
        "flex items-center gap-1 overflow-x-auto rounded-lg border border-line-subtle bg-surface-card/80 p-1 shadow-1 backdrop-blur-sm",
        className,
      )}
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? "page" : undefined}
          className={clsx(
            "relative inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-ui transition-[background-color,color,box-shadow] duration-fast ease-out",
            item.active
              ? "bg-accent-soft/85 font-semibold text-accent-strong shadow-1 ring-1 ring-accent/25"
              : "font-medium text-fg-secondary hover:bg-surface-sunken/70 hover:text-fg-primary",
          )}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.badge}
        </Link>
      ))}
    </nav>
  );
}
