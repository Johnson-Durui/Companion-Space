import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

export interface SkeletonProps {
  className?: string;
  height?: string | number;
  width?: string | number;
  rounded?: "sm" | "md" | "lg" | "full";
}

const ROUNDED_CLASSES = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

export function Skeleton({ className, height, width, rounded = "md" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={clsx("cs-skeleton bg-surface-sunken", ROUNDED_CLASSES[rounded], className)}
      style={{ height, width }}
    />
  );
}

export interface DelayedSkeletonProps {
  loading: boolean;
  delayMs?: number;
  minDisplayMs?: number;
  label?: string;
  fallback?: ReactNode;
  children?: ReactNode;
}

/**
 * Shows loading UI only after delayMs (default 400ms), and once shown,
 * keeps it visible for at least minDisplayMs (default 400ms) to avoid flicker.
 */
export function DelayedSkeleton({
  loading,
  delayMs = 400,
  minDisplayMs = 400,
  label = "正在加载…",
  fallback,
  children,
}: DelayedSkeletonProps) {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      if (visible) return;
      const timer = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, delayMs);
      return () => window.clearTimeout(timer);
    }

    if (!visible) return;
    const elapsed = shownAtRef.current ? Date.now() - shownAtRef.current : minDisplayMs;
    const remaining = Math.max(0, minDisplayMs - elapsed);
    const timer = window.setTimeout(() => {
      shownAtRef.current = null;
      setVisible(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [loading, visible, delayMs, minDisplayMs]);

  if (loading || visible) {
    if (!visible) {
      return (
        <div role="status" aria-live="polite" className="sr-only">
          {label}
        </div>
      );
    }
    return (
      <div role="status" aria-live="polite" aria-label={label}>
        {fallback ?? <PageSkeleton />}
      </div>
    );
  }
  return <>{children}</>;
}

export function PageSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx("grid gap-4 py-6", className)} aria-hidden="true">
      <Skeleton className="h-7 w-48" rounded="md" />
      <div className="grid gap-3 rounded-lg border border-line-subtle bg-surface-card p-6 shadow-1">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton
            key={index}
            className={clsx("h-4", index === lines - 1 ? "w-2/3" : "w-full")}
            rounded="sm"
          />
        ))}
      </div>
    </div>
  );
}
