import type { ReactElement, ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

export interface TooltipProviderProps {
  children: ReactNode;
  delay?: number;
}

export function TooltipProvider({ children, delay = 350 }: TooltipProviderProps) {
  return <BaseTooltip.Provider delay={delay}>{children}</BaseTooltip.Provider>;
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-popover">
          <BaseTooltip.Popup className="cs-tooltip-popup max-w-60 rounded-sm bg-fg-primary px-2.5 py-1.5 text-caption font-medium text-surface-card shadow-2">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
