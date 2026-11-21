import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent border-accent hover:bg-accent-strong hover:border-accent-strong",
  secondary:
    "bg-surface-card text-fg-primary border-line-default hover:bg-surface-sunken hover:border-line-control",
  ghost:
    "bg-transparent text-fg-primary border-transparent hover:bg-surface-sunken",
  danger:
    "bg-surface-card text-danger border-line-default hover:bg-danger-soft hover:border-danger",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 py-1 text-caption rounded-sm gap-1.5",
  md: "min-h-10 px-4 py-2 text-ui rounded-md gap-2",
  lg: "min-h-12 px-5 py-2.5 text-body rounded-md gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    pending = false,
    disabled = false,
    leftIcon,
    rightIcon,
    className,
    children,
    type = "button",
    onClick,
    ...rest
  },
  ref,
) {
  const isBlocked = disabled || pending;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={isBlocked || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={clsx(
        "relative inline-flex items-center justify-center border font-medium select-none",
        "transition-[background-color,border-color,color,transform] duration-fast ease-out",
        "active:not-disabled:scale-[0.97] active:duration-instant",
        "disabled:opacity-55 disabled:cursor-not-allowed",
        pending && "cursor-progress",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      <span
        className={clsx(
          "inline-flex items-center justify-center gap-[inherit]",
          pending && "opacity-75",
        )}
      >
        {pending ? <Spinner size={size === "sm" ? 14 : 16} /> : leftIcon}
        <span>{children}</span>
        {!pending ? rightIcon : null}
      </span>
    </button>
  );
});
