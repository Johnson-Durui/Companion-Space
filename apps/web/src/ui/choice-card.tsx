import type { ReactNode } from "react";
import clsx from "clsx";
import { Check, CheckCircle2, XCircle } from "./icons";

export type ChoiceCardOutcome = "correct" | "retry" | null;

export interface ChoiceCardOption {
  key: string;
  text: string;
  content?: ReactNode;
}

export interface ChoiceCardProps {
  optionKey: string;
  text: string;
  content?: ReactNode;
  mode?: "single" | "multi";
  selected?: boolean;
  disabled?: boolean;
  outcome?: ChoiceCardOutcome;
  onSelect: () => void;
  className?: string;
}

export function ChoiceCard({
  optionKey,
  text,
  content,
  mode = "single",
  selected = false,
  disabled = false,
  outcome = null,
  onSelect,
  className,
}: ChoiceCardProps) {
  const role = mode === "multi" ? "checkbox" : "radio";
  const accessibleName = `${optionKey} ${text}`.trim();

  const stateClass =
    outcome === "correct"
      ? "bg-ok-soft border-ok text-fg-primary"
      : outcome === "retry"
        ? "bg-retry-soft border-retry text-fg-primary cs-choice-shake"
        : selected
          ? "bg-surface-card border-accent ring-1 ring-accent/25 text-fg-primary"
          : "bg-surface-card border-line-default text-fg-primary hover:border-line-control hover:bg-surface-sunken/60";

  const keyBadgeClass =
    outcome === "correct"
      ? "bg-ok text-on-accent border-ok"
      : outcome === "retry"
        ? "bg-retry text-on-accent border-retry"
        : selected
          ? "bg-accent text-on-accent border-accent"
          : "bg-surface-sunken text-fg-secondary border-line-default";

  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      aria-label={accessibleName}
      disabled={disabled}
      data-choice-key={optionKey}
      data-selected={selected || undefined}
      data-outcome={outcome ?? undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className={clsx(
        "group relative flex w-full min-h-11 items-start gap-3 rounded-md border-2 px-3.5 py-2.5 text-left",
        "transition-[background-color,border-color,box-shadow,transform] duration-fast ease-out",
        "active:not-disabled:scale-[0.99] active:duration-instant",
        "disabled:cursor-not-allowed disabled:opacity-75",
        stateClass,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border text-caption font-semibold tabular-nums",
          mode === "multi" ? "rounded-xs" : "rounded-full",
          keyBadgeClass,
        )}
      >
        {optionKey}
      </span>
      <span className="min-w-0 flex-1 text-ui leading-snug break-words [&>p]:m-0">
        {content ?? text}
      </span>
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {outcome === "correct" ? (
          <CheckCircle2 size={18} className="text-ok" />
        ) : outcome === "retry" ? (
          <XCircle size={18} className="text-retry" />
        ) : selected ? (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
            <Check size={13} strokeWidth={2.5} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

export interface ChoiceCardGroupProps {
  options: ChoiceCardOption[];
  mode?: "single" | "multi";
  value: string | string[];
  onChange: (next: string | string[]) => void;
  disabled?: boolean;
  /** Optional map of option key -> outcome ("correct" | "retry") */
  outcomes?: Record<string, ChoiceCardOutcome>;
  label?: string;
  className?: string;
}

export function ChoiceCardGroup({
  options,
  mode = "single",
  value,
  onChange,
  disabled = false,
  outcomes,
  label,
  className,
}: ChoiceCardGroupProps) {
  const selectedSet = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const allShort =
    options.length >= 2 &&
    options.every((option) => option.text.trim().length > 0 && option.text.trim().length <= 12);
  const gridCols = allShort
    ? options.length === 3 || options.length === 6
      ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
      : "grid-cols-1 sm:grid-cols-2"
    : "grid-cols-1";

  const toggleOption = (key: string) => {
    if (disabled) return;
    if (mode === "multi") {
      const current = Array.isArray(value) ? value : [];
      const next = current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key];
      onChange(next);
    } else {
      onChange(key);
    }
  };

  return (
    <div
      role={mode === "multi" ? "group" : "radiogroup"}
      aria-label={label}
      className={clsx("grid gap-2", gridCols, className)}
    >
      {options.map((option) => (
        <ChoiceCard
          key={option.key}
          optionKey={option.key}
          text={option.text}
          content={option.content}
          mode={mode}
          selected={selectedSet.has(option.key)}
          disabled={disabled}
          outcome={outcomes?.[option.key] ?? null}
          onSelect={() => toggleOption(option.key)}
        />
      ))}
    </div>
  );
}
