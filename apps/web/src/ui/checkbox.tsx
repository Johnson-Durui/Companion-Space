import type { InputHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, disabled, ...props }: CheckboxProps) {
  return (
    <label
      className={clsx(
        "inline-flex min-h-10 items-center gap-2.5 select-none",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        disabled={disabled}
        className="h-4 w-4 shrink-0 rounded-sm border border-line-control accent-[var(--accent)]"
        {...props}
      />
      <span className="grid gap-0.5 text-ui text-fg-primary">
        <span>{label}</span>
        {description ? <span className="text-caption text-fg-secondary">{description}</span> : null}
      </span>
    </label>
  );
}
