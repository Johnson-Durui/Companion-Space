import { Select as BaseSelect } from "@base-ui/react/select";
import clsx from "clsx";
import { useFieldContext } from "./field";
import { Check, ChevronDown } from "./icons";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

export function Select<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = "请选择",
  disabled,
  name,
  id,
  "aria-label": ariaLabel,
  className,
}: SelectProps<T>) {
  const field = useFieldContext();
  const labelMap = new Map(options.map((opt) => [opt.value, opt.label]));

  return (
    <BaseSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (next != null) onValueChange?.(next as T);
      }}
      disabled={disabled}
      name={name}
    >
      <BaseSelect.Trigger
        id={id ?? field?.id}
        aria-label={ariaLabel}
        aria-invalid={field?.invalid || undefined}
        aria-describedby={
          [field?.descriptionId, field?.errorId].filter(Boolean).join(" ") || undefined
        }
        className={clsx(
          "inline-flex min-h-10 w-full items-center justify-between gap-2 rounded-md border bg-surface-card px-3 py-2 text-left text-ui text-fg-primary",
          "transition-[border-color,background-color] duration-fast ease-out",
          field?.invalid
            ? "border-danger"
            : "border-line-control hover:border-fg-secondary data-[popup-open]:border-accent",
          "disabled:bg-surface-sunken disabled:text-fg-disabled disabled:cursor-not-allowed",
          className,
        )}
      >
        <BaseSelect.Value placeholder={placeholder}>
          {(val) => (val ? (labelMap.get(val as T) ?? String(val)) : placeholder)}
        </BaseSelect.Value>
        <BaseSelect.Icon className="text-fg-secondary shrink-0">
          <ChevronDown size={16} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-popover">
          <BaseSelect.Popup
            className={clsx(
              "cs-menu-popup max-h-72 min-w-[var(--anchor-width,12rem)] overflow-y-auto rounded-md border border-line-subtle bg-surface-overlay p-1 shadow-2",
            )}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={clsx(
                    "flex min-h-9 cursor-pointer items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-ui text-fg-primary outline-none select-none",
                    "data-[highlighted]:bg-surface-sunken data-[selected]:text-accent-strong data-[selected]:font-medium",
                    "data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed",
                  )}
                >
                  <span className="grid gap-0.5">
                    <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                    {option.description ? (
                      <span className="text-caption text-fg-secondary">{option.description}</span>
                    ) : null}
                  </span>
                  <BaseSelect.ItemIndicator className="text-accent shrink-0">
                    <Check size={15} aria-hidden="true" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
