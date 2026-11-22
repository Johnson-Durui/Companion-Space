import { useId, useState, type DragEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Upload } from "./icons";

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  title: ReactNode;
  description?: ReactNode;
  buttonLabel: string;
  className?: string;
}

export function FileDropzone({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  title,
  description,
  buttonLabel,
  className,
}: FileDropzoneProps) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length) onFiles(dropped);
  }

  return (
    <div
      data-dragging={dragging || undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        "grid place-items-center gap-3 rounded-lg border-2 border-dashed p-6 sm:p-8 text-center transition-[border-color,background-color] duration-fast ease-out",
        dragging
          ? "border-accent bg-accent-soft/70"
          : "border-line-default bg-surface-card hover:border-line-control",
        disabled && "opacity-55 pointer-events-none",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "inline-flex h-12 w-12 items-center justify-center rounded-full",
          dragging ? "bg-accent text-on-accent" : "bg-surface-sunken text-fg-secondary",
        )}
      >
        <Upload size={22} />
      </span>
      <div className="grid gap-1">
        <strong className="text-body font-semibold text-fg-primary">{title}</strong>
        {description ? <p className="text-ui text-fg-secondary">{description}</p> : null}
      </div>
      <label
        htmlFor={inputId}
        className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-line-control bg-surface-card px-4 text-ui font-medium text-fg-primary transition-colors duration-fast ease-out hover:bg-surface-sunken"
      >
        <span>{buttonLabel}</span>
        <input
          id={inputId}
          type="file"
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            const chosen = event.target.files ? Array.from(event.target.files) : [];
            if (chosen.length) onFiles(chosen);
            event.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
