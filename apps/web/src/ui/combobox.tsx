import { useId } from "react";
import clsx from "clsx";
import { useFieldContext } from "./field";

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  "aria-label"?: string;
  className?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  name,
  id,
  disabled,
  required,
  maxLength,
  "aria-label": ariaLabel,
  className,
}: ComboboxProps) {
  const listId = useId();
  const field = useFieldContext();

  return (
    <>
      <input
        id={id ?? field?.id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={options.length ? listId : undefined}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        maxLength={maxLength}
        aria-label={ariaLabel}
        aria-invalid={field?.invalid || undefined}
        aria-describedby={
          [field?.descriptionId, field?.errorId].filter(Boolean).join(" ") || undefined
        }
        className={clsx(
          "min-h-10 w-full rounded-md border bg-surface-card px-3 py-2 text-ui text-fg-primary placeholder:text-fg-tertiary",
          "transition-[border-color,background-color] duration-fast ease-out",
          field?.invalid
            ? "border-danger focus:border-danger"
            : "border-line-control hover:border-fg-secondary focus:border-accent",
          "disabled:bg-surface-sunken disabled:text-fg-disabled disabled:cursor-not-allowed",
          className,
        )}
      />
      {options.length ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}
