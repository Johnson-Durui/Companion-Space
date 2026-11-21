import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "./spinner";

export type IconButtonVariant = "ghost" | "secondary" | "primary" | "danger";
export type IconButtonSize = "sm" | "md" | "lg" | "xl";
export type IconButtonShape = "round" | "square";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: IconButtonShape;
  pending?: boolean;
  active?: boolean;
}

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  ghost:
    "bg-transparent text-fg-primary border-transparent hover:bg-surface-sunken",
  secondary:
    "bg-surface-card text-fg-primary border-line-default hover:bg-surface-sunken hover:border-line-control",
  primary:
    "bg-accent text-on-accent border-accent hover:bg-accent-strong hover:border-accent-strong",
  danger:
    "bg-danger text-on-accent border-danger hover:opacity-90",
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: "h-9 w-9",
  md: "h-10 w-10",
  lg: "h-11 w-11",
  xl: "h-14 w-14",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    variant = "ghost",
    size = "md",
    shape = "round",
    pending = false,
    disabled = false,
    active = false,
    className,
    type = "button",
    onClick,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={pending || undefined}
      aria-pressed={active || undefined}
      onClick={(event) => {
        if (pending || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center border",
        "transition-[background-color,border-color,color,transform] duration-fast ease-out",
        "active:not-disabled:scale-[0.97] active:duration-instant",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        pending && "cursor-progress",
        shape === "round" ? "rounded-full" : "rounded-md",
        active && variant !== "primary" && "border-accent bg-accent-soft text-accent-strong",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {pending ? <Spinner size={18} /> : icon}
    </button>
  );
});
