import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { X } from "./icons";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  side?: "right" | "bottom";
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  testId?: string;
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  side = "right",
  children,
  closeLabel = "关闭",
  className,
  testId,
}: DrawerProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="cs-backdrop fixed inset-0 z-modal bg-scrim" />
        <BaseDialog.Viewport
          className={clsx(
            "fixed inset-0 z-modal flex",
            side === "right" ? "justify-end" : "items-end justify-center",
          )}
        >
          <BaseDialog.Popup
            data-testid={testId}
            className={clsx(
              "relative flex flex-col border-line-subtle bg-surface-overlay text-fg-primary shadow-3 outline-none",
              side === "right"
                ? "cs-drawer-right h-full w-full max-w-[380px] border-l"
                : "cs-drawer-bottom max-h-[82dvh] w-full max-w-lg rounded-t-xl border-t pb-[env(safe-area-inset-bottom)]",
              className,
            )}
          >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line-subtle px-5 py-4">
              <div className="grid min-w-0 gap-0.5">
                <BaseDialog.Title className="text-body font-semibold text-fg-primary">
                  {title}
                </BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description className="text-caption text-fg-secondary">
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
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
