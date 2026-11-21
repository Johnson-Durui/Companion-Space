import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  visual?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ visual, title, description, action, className }: EmptyStateProps) {
  return (
    <section
      className={clsx(
        "grid justify-items-center gap-3 rounded-lg border border-line-subtle bg-surface-card px-6 py-12 text-center shadow-1",
        className,
      )}
    >
      {visual ? <div className="text-accent">{visual}</div> : null}
      <h2 className="text-title font-semibold text-fg-primary">{title}</h2>
      {description ? (
        <p className="max-w-md text-ui text-fg-secondary">{description}</p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </section>
  );
}
