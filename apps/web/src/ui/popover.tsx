import type { ReactElement, ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import clsx from "clsx";

export interface PopoverProps {
  trigger: ReactElement;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}

export function Popover({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "end",
  className,
}: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={8} className="z-popover">
          <BasePopover.Popup
            className={clsx(
              "cs-menu-popup grid w-72 gap-3 rounded-lg border border-line-subtle bg-surface-overlay p-4 text-fg-primary shadow-2 outline-none",
              className,
            )}
          >
            {title || description ? (
              <div className="grid gap-1">
                {title ? (
                  <BasePopover.Title className="text-ui font-semibold text-fg-primary">
                    {title}
                  </BasePopover.Title>
                ) : null}
                {description ? (
                  <BasePopover.Description className="text-caption text-fg-secondary">
                    {description}
                  </BasePopover.Description>
                ) : null}
              </div>
            ) : null}
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
