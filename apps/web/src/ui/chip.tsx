import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Check } from "./icons";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  showCheck?: boolean;
  icon?: ReactNode;
}

/**
 * Selectable chip: per design-system §2.3, selected state uses accent border +
 * soft tint + optional check mark (never solid accent fill) to stay distinct
 * from status colors across all 8 tutor themes.
 */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, showCheck = false, icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={clsx(
        "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-ui font-medium",
        "transition-[background-color,border-color,color,transform] duration-fast ease-out",
        "active:not-disabled:scale-[0.97] active:duration-instant",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        selected
          ? "border-accent bg-accent-soft text-accent-strong"
          : "border-line-default bg-surface-card text-fg-secondary hover:border-line-control hover:text-fg-primary",
        className,
      )}
      {...rest}
    >
      {selected && showCheck ? <Check size={14} aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
});
