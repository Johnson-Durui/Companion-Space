import type { KeyboardEvent, ReactNode } from "react";
import clsx from "clsx";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const enabled = options.filter((opt) => !opt.disabled);
    if (!enabled.length) return;
    const currentIndex = enabled.findIndex((opt) => opt.value === value);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % enabled.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = enabled.length - 1;

    event.preventDefault();
    const target = enabled[nextIndex];
    if (target) {
      onValueChange(target.value);
      const radio = event.currentTarget.querySelector<HTMLButtonElement>(
        `[data-segment-value="${CSS.escape(target.value)}"]`,
      );
      radio?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border border-line-subtle bg-surface-sunken p-1",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            data-segment-value={option.value}
            onClick={() => onValueChange(option.value)}
            className={clsx(
              "inline-flex items-center justify-center rounded-sm font-medium whitespace-nowrap select-none",
              "transition-[background-color,color,box-shadow,border-color] duration-fast ease-out",
              size === "sm" ? "min-h-7 px-2.5 text-caption" : "min-h-8 px-3 text-ui",
              selected
                ? "border border-accent bg-surface-card text-accent-strong shadow-1"
                : "border border-transparent text-fg-secondary hover:text-fg-primary",
              "disabled:opacity-45 disabled:cursor-not-allowed",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
