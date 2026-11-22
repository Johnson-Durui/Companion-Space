import clsx from "clsx";

export interface LevelMeterProps {
  /** Normalized level in [0, 1] */
  value: number;
  label: string;
  className?: string;
}

export function LevelMeter({ value, label, className }: LevelMeterProps) {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const percent = Math.round(clamped * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={clsx(
        "relative h-2 w-20 overflow-hidden rounded-full bg-surface-sunken border border-line-subtle",
        className,
      )}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-instant ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
