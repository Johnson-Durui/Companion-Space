import { createContext, useContext, useId, type ReactNode } from "react";
import clsx from "clsx";

interface FieldContextValue {
  id: string;
  descriptionId?: string;
  errorId?: string;
  invalid: boolean;
  required?: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: string;
  htmlFor?: string;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  description,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const descriptionId = description ? `${id}-desc` : undefined;
  const errorId = error ? `${id}-err` : undefined;
  const invalid = Boolean(error);

  return (
    <FieldContext.Provider value={{ id, descriptionId, errorId, invalid, required }}>
      <div className={clsx("grid gap-1.5 min-w-0", className)}>
        <div className="flex items-center gap-1">
          <label htmlFor={id} className="text-ui font-medium text-fg-primary">
            {label}
          </label>
          {required ? (
            <span className="text-ui leading-none text-danger" aria-hidden="true">*</span>
          ) : null}
        </div>
        {children}
        {description ? (
          <p id={descriptionId} className="text-caption text-fg-secondary">
            {description}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-caption font-medium text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
