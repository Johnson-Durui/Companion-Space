import clsx from "clsx";
import { Check, Clock } from "./icons";

export type StepStatus = "done" | "active" | "todo" | "waiting";

export interface StepperItem {
  id: string;
  label: string;
  status: StepStatus;
  hint?: string;
  disabled?: boolean;
}

export interface StepperProps {
  steps: StepperItem[];
  currentId?: string;
  onSelect?: (id: string) => void;
  compact?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function Stepper({
  steps,
  currentId,
  onSelect,
  compact = false,
  "aria-label": ariaLabel = "步骤进度",
  className,
}: StepperProps) {
  return (
    <ol
      aria-label={ariaLabel}
      className={clsx(
        "flex items-center gap-1.5 overflow-x-auto",
        compact ? "py-0.5" : "w-full justify-between gap-2",
        className,
      )}
    >
      {steps.map((step, index) => {
        const isCurrent = currentId ? step.id === currentId : step.status === "active";
        const clickable = Boolean(onSelect && !step.disabled);
        const content = (
          <>
            <span
              aria-hidden="true"
              className={clsx(
                "inline-flex shrink-0 items-center justify-center rounded-full text-caption font-semibold transition-colors duration-fast ease-out",
                compact ? "h-6 w-6" : "h-7 w-7",
                step.status === "done"
                  ? "bg-ok text-on-accent"
                  : isCurrent
                    ? "bg-accent text-on-accent"
                    : step.status === "waiting"
                      ? "bg-surface-sunken text-fg-tertiary border border-dashed border-line-control"
                      : "bg-surface-sunken text-fg-secondary border border-line-default",
              )}
            >
              {step.status === "done" ? (
                <Check size={14} strokeWidth={2.4} />
              ) : step.status === "waiting" ? (
                <Clock size={13} />
              ) : (
                index + 1
              )}
            </span>
            <span className="grid min-w-0 text-left">
              <span
                className={clsx(
                  "truncate text-caption sm:text-ui",
                  isCurrent
                    ? "font-semibold text-fg-primary"
                    : step.status === "done"
                      ? "font-medium text-fg-primary"
                      : "font-medium text-fg-secondary",
                )}
              >
                {step.label}
              </span>
              {!compact && step.hint ? (
                <span className="truncate text-caption text-fg-tertiary">{step.hint}</span>
              ) : null}
            </span>
          </>
        );

        return (
          <li
            key={step.id}
            data-step={step.id}
            data-status={step.status}
            aria-current={isCurrent ? "step" : undefined}
            className={clsx("flex items-center gap-1.5", !compact && "min-w-0 flex-1 last:flex-none")}
          >
            {clickable ? (
              <button
                type="button"
                onClick={() => onSelect?.(step.id)}
                className={clsx(
                  "inline-flex min-h-10 items-center gap-2 rounded-md px-2 py-1 transition-colors duration-fast ease-out hover:bg-surface-sunken",
                  isCurrent && "bg-accent-soft/60",
                )}
              >
                {content}
              </button>
            ) : (
              <span
                className={clsx(
                  "inline-flex min-h-9 items-center gap-2 rounded-md px-1.5 py-1",
                  step.disabled && "opacity-70",
                )}
              >
                {content}
              </span>
            )}
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={clsx(
                  "h-px shrink-0",
                  compact ? "w-4 sm:w-6" : "hidden sm:block flex-1 min-w-3",
                  step.status === "done" ? "bg-ok/60" : "bg-line-subtle",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
