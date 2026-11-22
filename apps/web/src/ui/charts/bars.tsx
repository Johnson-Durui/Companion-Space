import clsx from "clsx";
import { normalizeMasteryStatus } from "./mastery-grid";

export function WeightBar({
  weight,
  label,
  valueText,
  className,
}: {
  weight: number;
  label: string;
  valueText: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(weight > 0 ? 8 : 0, Math.round(weight * 100)));
  return (
    <span className={clsx("inline-flex items-center gap-2 text-caption text-fg-secondary", className)}>
      <span>{label}</span>
      <svg
        width="76"
        height="8"
        viewBox="0 0 76 8"
        role="img"
        aria-label={`${label} ${valueText}`}
        className="shrink-0 overflow-visible"
      >
        <rect x="0" y="1" width="76" height="6" rx="3" fill="var(--surface-sunken)" />
        {pct > 0 ? (
          <rect x="0" y="1" width={Math.max(4, (pct / 100) * 76)} height="6" rx="3" fill="var(--accent)" />
        ) : null}
      </svg>
      <span className="font-medium text-fg-primary">{valueText}</span>
    </span>
  );
}

export function MasteryBar({
  probability,
  status,
  label,
  valueText,
  className,
}: {
  probability: number;
  status?: string;
  label: string;
  valueText: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(probability > 0 ? 6 : 0, Math.round(probability * 100)));
  const norm = status ? normalizeMasteryStatus(status) : probability >= 0.85 ? "mastered" : probability >= 0.45 ? "learning" : probability > 0 ? "shaky" : "unseen";
  const fillVar =
    norm === "mastered"
      ? "var(--mastery-mastered)"
      : norm === "shaky"
        ? "var(--mastery-fragile)"
        : norm === "learning"
          ? "var(--mastery-learning)"
          : "var(--mastery-unseen)";

  return (
    <span className={clsx("inline-flex items-center gap-2 text-caption text-fg-secondary", className)}>
      <span>{label}</span>
      <svg
        width="76"
        height="8"
        viewBox="0 0 76 8"
        role="img"
        aria-label={`${label} ${valueText}`}
        className="shrink-0 overflow-visible"
      >
        <rect x="0" y="1" width="76" height="6" rx="3" fill="var(--surface-sunken)" />
        {pct > 0 ? (
          <rect x="0" y="1" width={Math.max(4, (pct / 100) * 76)} height="6" rx="3" fill={fillVar} />
        ) : null}
      </svg>
      <span className="font-medium text-fg-primary">{valueText}</span>
    </span>
  );
}

export function ScoreBar({
  secured,
  scale,
  target,
  label,
  targetLabel,
  gapLabel,
  reachedLabel,
}: {
  secured: number;
  scale: number;
  target?: number | null;
  label: string;
  targetLabel?: string;
  gapLabel?: string;
  reachedLabel?: string;
}) {
  const safeScale = Math.max(1, scale || 100);
  const clampedSecured = Math.max(0, Math.min(safeScale, secured));
  const fillPct = (clampedSecured / safeScale) * 100;
  const targetPct =
    target != null && target > 0 ? Math.max(2, Math.min(100, (target / safeScale) * 100)) : null;
  const gap = target != null ? Math.round((target - clampedSecured) * 10) / 10 : null;

  return (
    <div className="grid gap-2" data-testid="score-bar">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-headline font-semibold tabular-nums text-fg-primary">
            {clampedSecured.toFixed(1)}
          </span>
          <span className="text-ui tabular-nums text-fg-tertiary">/ {safeScale.toFixed(0)}</span>
        </div>
        {target != null ? (
          <span className="text-caption font-medium text-fg-secondary">
            {gap !== null && gap <= 0
              ? reachedLabel || targetLabel
              : gapLabel?.replace("{gap}", String(gap)).replace("{target}", String(target)) || targetLabel}
          </span>
        ) : null}
      </div>
      <svg
        viewBox="0 0 400 28"
        className="h-7 w-full"
        role="img"
        aria-label={`${label} ${clampedSecured.toFixed(1)} / ${safeScale.toFixed(0)}${target != null ? ` · ${targetLabel ?? target}` : ""}`}
      >
        <rect x="0" y="9" width="400" height="10" rx="5" fill="var(--surface-sunken)" />
        {fillPct > 0 ? (
          <rect
            x="0"
            y="9"
            width={Math.max(8, (fillPct / 100) * 400)}
            height="10"
            rx="5"
            fill="var(--accent)"
          />
        ) : null}
        {targetPct !== null ? (
          <g>
            <line
              x1={(targetPct / 100) * 400}
              y1="2"
              x2={(targetPct / 100) * 400}
              y2="26"
              stroke="var(--text-primary)"
              strokeWidth="2"
              strokeDasharray="3 2"
            />
            <circle cx={(targetPct / 100) * 400} cy="4" r="2.5" fill="var(--text-primary)" />
          </g>
        ) : null}
      </svg>
    </div>
  );
}

export function ScoreRing({
  score,
  maxScore,
  label,
  size = 112,
}: {
  score: number;
  maxScore: number;
  label: string;
  size?: number;
}) {
  const safeMax = Math.max(1, maxScore || 1);
  const ratio = Math.max(0, Math.min(1, score / safeMax));
  const pct = Math.round(ratio * 100);
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);
  const strokeColor =
    ratio >= 0.8 ? "var(--ok)" : ratio >= 0.5 ? "var(--accent)" : "var(--retry)";

  return (
    <div className="relative inline-flex items-center justify-center" data-testid="score-ring">
      <svg
        width={size}
        height={size}
        viewBox="0 0 104 104"
        role="img"
        aria-label={`${label} ${score} / ${maxScore} (${pct}%)`}
      >
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke="var(--surface-sunken)"
          strokeWidth="9"
        />
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 52 52)"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <strong className="text-title font-semibold tabular-nums text-fg-primary">
          {score}/{maxScore}
        </strong>
        <span className="text-caption tabular-nums text-fg-tertiary">{pct}%</span>
      </div>
    </div>
  );
}

export function SegmentProgress({
  current,
  total,
  label,
  className,
}: {
  current: number;
  total: number;
  label: string;
  className?: string;
}) {
  const count = Math.max(1, Math.min(24, total));
  const gap = 4;
  const width = 160;
  const segW = (width - gap * (count - 1)) / count;

  return (
    <svg
      width={width}
      height="8"
      viewBox={`0 0 ${width} 8`}
      role="img"
      aria-label={`${label} ${current} / ${total}`}
      className={clsx("shrink-0", className)}
    >
      {Array.from({ length: count }, (_, idx) => {
        const step = idx + 1;
        const done = step < current;
        const active = step === current;
        return (
          <rect
            key={step}
            x={idx * (segW + gap)}
            y="1"
            width={Math.max(2, segW)}
            height="6"
            rx="3"
            fill={done || active ? "var(--accent)" : "var(--surface-sunken)"}
            fillOpacity={done ? 0.55 : 1}
          />
        );
      })}
    </svg>
  );
}
