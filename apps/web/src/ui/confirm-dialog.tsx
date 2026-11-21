import { useRef, type ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirmation dialog using Base UI AlertDialog.
 * Safe action (cancel) always receives initial focus per design-system §5 & §8.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  danger = true,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="cs-backdrop fixed inset-0 z-modal bg-scrim" />
        <AlertDialog.Viewport className="fixed inset-0 z-modal flex items-center justify-center p-4">
          <AlertDialog.Popup
            initialFocus={cancelRef}
            className="cs-dialog-popup grid w-full max-w-md gap-4 rounded-lg border border-line-subtle bg-surface-overlay p-6 text-fg-primary shadow-3 outline-none"
          >
            <div className="grid gap-2">
              <AlertDialog.Title className="text-title font-semibold text-fg-primary">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-ui text-fg-secondary">
                {description}
              </AlertDialog.Description>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <Button
                ref={cancelRef}
                variant="secondary"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel}
              </Button>
              <Button
                variant={danger ? "danger" : "primary"}
                pending={pending}
                onClick={async () => {
                  await onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
