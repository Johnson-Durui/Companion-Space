import { forwardRef, type HTMLAttributes } from "react";
import clsx from "clsx";

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  interactive?: boolean;
  surface?: "desk" | "paper";
}

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: "p-0",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padding = "md", interactive = false, surface, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-surface={surface === "paper" ? "paper" : undefined}
      className={clsx(
        "rounded-lg border border-line-subtle bg-surface-card text-fg-primary shadow-1",
        PADDING_CLASSES[padding],
        interactive && [
          "transition-[box-shadow,border-color,transform] duration-fast ease-out",
          "hover:border-line-default hover:shadow-2",
        ],
        className,
      )}
      {...rest}
    />
  );
});
