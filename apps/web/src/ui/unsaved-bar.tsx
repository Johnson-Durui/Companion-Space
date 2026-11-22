import { useEffect } from "react";
import { Button } from "./button";

export interface UnsavedBarProps {
  dirty: boolean;
  pending?: boolean;
  message?: string;
  saveLabel?: string;
  discardLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  warnOnUnload?: boolean;
}

export function UnsavedBar({
  dirty,
  pending = false,
  message = "你有未保存的更改",
  saveLabel = "保存更改",
  discardLabel = "放弃更改",
  onSave,
  onDiscard,
  warnOnUnload = true,
}: UnsavedBarProps) {
  useEffect(() => {
    if (!dirty || !warnOnUnload) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, warnOnUnload]);

  if (!dirty) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="unsaved-bar"
      className="cs-toast-item sticky bottom-4 z-sticky mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/35 bg-surface-overlay px-4 py-3 shadow-2"
    >
      <span className="text-ui font-medium text-fg-primary">{message}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending} onClick={onDiscard}>
          {discardLabel}
        </Button>
        <Button variant="primary" size="sm" pending={pending} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
