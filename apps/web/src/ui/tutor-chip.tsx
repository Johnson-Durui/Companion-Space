import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
import { TutorAvatar } from "./tutor-avatar";

export interface TutorChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  name: string;
  src?: string | null;
  subtitle?: ReactNode;
  interactive?: boolean;
}

export function TutorChip({
  name,
  src,
  subtitle,
  interactive = false,
  className,
  onClick,
  ...rest
}: TutorChipProps) {
  const content = (
    <>
      <TutorAvatar src={src} name={name} size="sm" />
      <span className="grid text-left leading-tight">
        <span className="text-ui font-medium text-fg-primary">{name}</span>
        {subtitle ? <span className="text-caption text-fg-secondary">{subtitle}</span> : null}
      </span>
    </>
  );

  const shared = clsx(
    "inline-flex min-h-10 items-center gap-2 rounded-full border border-line-subtle bg-surface-card py-1 pl-1.5 pr-3 shadow-1",
    className,
  );

  if (interactive || onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          shared,
          "transition-[border-color,background-color,transform] duration-fast ease-out",
          "hover:border-accent hover:bg-accent-soft active:scale-[0.97] active:duration-instant",
        )}
        {...rest}
      >
        {content}
      </button>
    );
  }

  return <span className={shared}>{content}</span>;
}
