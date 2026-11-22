import type { ReactElement, ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import clsx from "clsx";

export interface MenuItemEntry {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  trigger: ReactElement;
  items: MenuItemEntry[];
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}

export function Menu({ trigger, items, align = "end", side = "bottom" }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-popover">
          <BaseMenu.Popup className="cs-menu-popup min-w-44 rounded-md border border-line-subtle bg-surface-overlay p-1 shadow-2 outline-none">
            {items.map((item) => (
              <BaseMenu.Item
                key={item.id}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={clsx(
                  "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-ui outline-none select-none",
                  item.danger
                    ? "text-danger-text data-[highlighted]:bg-danger-soft"
                    : "text-fg-primary data-[highlighted]:bg-surface-sunken",
                  "data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed",
                )}
              >
                {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                <span>{item.label}</span>
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
