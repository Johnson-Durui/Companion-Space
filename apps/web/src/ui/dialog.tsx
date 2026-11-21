import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { X } from "./icons";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  closeLabel?: string;
}

const SIZE_CLASSES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  closeLabel = "关闭",
}: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="cs-backdrop fixed inset-0 z-modal bg-scrim" />
        <BaseDialog.Viewport className="fixed inset-0 z-modal flex items-center justify-center p-4 overflow-y-auto">
          <BaseDialog.Popup
            className={clsx(
              "cs-dialog-popup relative grid w-full gap-4 rounded-lg border border-line-subtle bg-surface-overlay p-6 text-fg-primary shadow-3 outline-none",
              SIZE_CLASSES[size],
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <BaseDialog.Title className="text-title font-semibold text-fg-primary">
                  {title}
                </BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description className="text-ui text-fg-secondary">
                    {description}
                  </BaseDialog.Description>
                ) : null}
              </div>
              <BaseDialog.Close
                aria-label={closeLabel}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
              >
                <X size={18} aria-hidden="true" />
              </BaseDialog.Close>
            </div>
            <div className="min-w-0">{children}</div>
            {footer ? (
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                {footer}
              </div>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
