import { forwardRef, type InputHTMLAttributes } from "react";
import clsx from "clsx";
import { useFieldContext } from "./field";

export type InputSize = "sm" | "md" | "lg";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: InputSize;
  invalid?: boolean;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: "min-h-8 px-2.5 py-1 text-caption rounded-sm",
  md: "min-h-10 px-3 py-2 text-ui rounded-md",
  lg: "min-h-12 px-3.5 py-2.5 text-body rounded-md",
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { inputSize = "md", invalid, id, className, "aria-describedby": describedByProp, ...rest },
  ref,
) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const describedBy =
    [field?.descriptionId, field?.errorId, describedByProp].filter(Boolean).join(" ") || undefined;

  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedBy}
      required={rest.required ?? field?.required}
      className={clsx(
        "w-full border bg-surface-card text-fg-primary placeholder:text-fg-tertiary",
        "transition-[border-color,box-shadow] duration-fast ease-out",
        isInvalid ? "border-danger" : "border-line-control hover:border-fg-secondary focus:border-accent",
        "disabled:bg-surface-sunken disabled:text-fg-disabled disabled:cursor-not-allowed",
        SIZE_CLASSES[inputSize],
        className,
      )}
      {...rest}
    />
  );
});
