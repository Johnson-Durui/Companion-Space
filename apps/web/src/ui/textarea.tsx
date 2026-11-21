import { forwardRef, type TextareaHTMLAttributes } from "react";
import clsx from "clsx";
import { useFieldContext } from "./field";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, id, rows = 3, className, "aria-describedby": describedByProp, ...rest },
  ref,
) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const describedBy =
    [field?.descriptionId, field?.errorId, describedByProp].filter(Boolean).join(" ") || undefined;

  return (
    <textarea
      ref={ref}
      id={id ?? field?.id}
      rows={rows}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedBy}
      required={rest.required ?? field?.required}
      className={clsx(
        "w-full resize-y rounded-md border bg-surface-card px-3 py-2 text-body text-fg-primary placeholder:text-fg-tertiary",
        "transition-[border-color,box-shadow] duration-fast ease-out",
        isInvalid ? "border-danger" : "border-line-control hover:border-fg-secondary focus:border-accent",
        "disabled:bg-surface-sunken disabled:text-fg-disabled disabled:cursor-not-allowed",
        className,
      )}
      {...rest}
    />
  );
});
