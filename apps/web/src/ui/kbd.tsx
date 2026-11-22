import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Kbd({ children, className, ...props }: KbdProps) {
  return (
    <kbd
      className={clsx(
        "inline-flex min-w-[24px] items-center justify-center rounded-sm border border-line-default bg-surface-sunken px-1.5 py-0.5 font-mono text-caption font-medium leading-none text-fg-primary shadow-1",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
