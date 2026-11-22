import { useState, type InputHTMLAttributes } from "react";
import clsx from "clsx";
import { useFieldContext } from "./field";
import { Eye, EyeOff } from "./icons";

export interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  showLabel?: string;
  hideLabel?: string;
  invalid?: boolean;
}

export function SecretInput({
  showLabel = "显示密钥",
  hideLabel = "隐藏密钥",
  invalid,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  ...props
}: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid;
  const describedBy =
    [ariaDescribedBy, field?.descriptionId, field?.errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="relative flex items-center">
      <input
        id={id ?? field?.id}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={clsx(
          "min-h-10 w-full rounded-md border bg-surface-card py-2 pl-3 pr-11 text-ui text-fg-primary placeholder:text-fg-tertiary",
          "transition-[border-color,background-color] duration-fast ease-out",
          isInvalid
            ? "border-danger focus:border-danger"
            : "border-line-control hover:border-fg-secondary focus:border-accent",
          "disabled:bg-surface-sunken disabled:text-fg-disabled disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
      <button
        type="button"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        onClick={() => setVisible((prev) => !prev)}
        className="absolute right-1 inline-flex h-8 w-8 items-center justify-center rounded-sm text-fg-secondary transition-colors duration-fast ease-out hover:bg-surface-sunken hover:text-fg-primary"
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
