import { useId, type ReactNode } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import clsx from "clsx";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
}

export function Switch({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  label,
  description,
  id,
  name,
  className,
  "aria-label": ariaLabel,
}: SwitchProps) {
  const autoId = useId();
  const controlId = id ?? autoId;

  const toggle = (
    <BaseSwitch.Root
      id={controlId}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={!label ? ariaLabel : undefined}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5",
        "bg-line-control transition-[background-color] duration-base ease-out",
        "data-[checked]:bg-accent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      <BaseSwitch.Thumb
        className={clsx(
          "block h-5 w-5 rounded-full bg-surface-card shadow-1",
          "transition-transform duration-base ease-out data-[checked]:translate-x-5",
        )}
      />
    </BaseSwitch.Root>
  );

  if (!label) return <span className={className}>{toggle}</span>;

  return (
    <div className={clsx("flex items-start justify-between gap-4", className)}>
      <div className="grid gap-0.5">
        <label htmlFor={controlId} className="text-ui font-medium text-fg-primary cursor-pointer">
          {label}
        </label>
        {description ? <p className="text-caption text-fg-secondary">{description}</p> : null}
      </div>
      {toggle}
    </div>
  );
}
