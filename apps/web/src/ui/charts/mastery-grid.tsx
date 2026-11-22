import clsx from "clsx";

export type MasteryStatus = "unseen" | "learning" | "shaky" | "mastered";

export interface MasteryGridPoint {
  id: string;
  name: string;
  unitId: string | null;
  unitTitle?: string;
  probability: number;
  status: string;
  weight?: number;
  evidenceCount?: number;
}

export interface MasteryGridProps {
  points: MasteryGridPoint[];
  statusLabels: Record<MasteryStatus, string>;
  ungroupedLabel: string;
  highWeightLabel: string;
  emptyLabel: string;
  onSelectPoint?: (point: MasteryGridPoint) => void;
}

export function normalizeMasteryStatus(status: string): MasteryStatus {
  if (status === "mastered" || status === "learning" || status === "shaky" || status === "unseen") {
    return status;
  }
  if (status === "fragile") return "shaky";
  return "unseen";
}

/**
 * Distinct SVG glyph per mastery status so status never relies on color alone (design-system §2.4 / §11).
 * - unseen: hollow circle
 * - learning: half-filled circle
 * - shaky: warning triangle
 * - mastered: solid circle with check
 */
export function MasteryShapeGlyph({
  status,
  size = 16,
  className,
}: {
  status: string;
  size?: number;
  className?: string;
}) {
  const norm = normalizeMasteryStatus(status);
  const colorVar =
    norm === "mastered"
      ? "var(--mastery-mastered)"
      : norm === "shaky"
        ? "var(--mastery-fragile)"
        : norm === "learning"
          ? "var(--mastery-learning)"
          : "var(--mastery-unseen)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={clsx("shrink-0", className)}
    >
      {norm === "unseen" ? (
        <circle cx="8" cy="8" r="5.5" stroke={colorVar} strokeWidth="1.6" strokeDasharray="2.5 2" />
      ) : norm === "learning" ? (
        <>
          <circle cx="8" cy="8" r="5.5" stroke={colorVar} strokeWidth="1.6" />
          <path d="M8 2.5A5.5 5.5 0 0 0 8 13.5Z" fill={colorVar} />
        </>
      ) : norm === "shaky" ? (
        <>
          <path
            d="M8 2.2 14 13.2H2L8 2.2Z"
            stroke={colorVar}
            strokeWidth="1.5"
            strokeLinejoin="round"
            fill={colorVar}
            fillOpacity="0.16"
          />
          <path d="M8 6.2V9.3" stroke={colorVar} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.3" r="0.85" fill={colorVar} />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6" fill={colorVar} />
          <path
            d="M5.2 8.2 7.1 10.1 10.9 6.1"
            stroke="var(--on-accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

export function MasteryGrid({
  points,
  statusLabels,
  ungroupedLabel,
  highWeightLabel,
  emptyLabel,
  onSelectPoint,
}: MasteryGridProps) {
  if (!points.length) {
    return <p className="text-ui text-fg-secondary">{emptyLabel}</p>;
  }

  const maxWeight = Math.max(...points.map((p) => p.weight ?? 0), 0);
  const groups: Array<{ id: string; title: string; items: MasteryGridPoint[] }> = [];
  const byUnit = new Map<string, { id: string; title: string; items: MasteryGridPoint[] }>();

  for (const point of points) {
    const key = point.unitId || "__ungrouped__";
    let group = byUnit.get(key);
    if (!group) {
      group = {
        id: key,
        title: point.unitTitle?.trim() || ungroupedLabel,
        items: [],
      };
      byUnit.set(key, group);
      groups.push(group);
    }
    group.items.push(point);
  }

  return (
    <div className="grid gap-4" data-testid="mastery-grid">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-fg-secondary">
        {(["mastered", "learning", "shaky", "unseen"] as const).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <MasteryShapeGlyph status={status} size={14} />
            <span>{statusLabels[status]}</span>
          </span>
        ))}
        {maxWeight > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-[4px] border-2 border-accent"
            />
            <span>{highWeightLabel}</span>
          </span>
        ) : null}
      </div>

      {/* Grouped unit tiles */}
      <div className="grid gap-4">
        {groups.map((group) => (
          <section key={group.id} className="grid gap-2">
            {groups.length > 1 || group.id !== "__ungrouped__" ? (
              <h3 className="text-caption font-semibold text-fg-secondary">{group.title}</h3>
            ) : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {group.items.map((point) => {
                const status = normalizeMasteryStatus(point.status);
                const pct = Math.round((point.probability || 0) * 100);
                const highWeight = maxWeight > 0 && (point.weight ?? 0) >= maxWeight * 0.65;
                const toneClasses =
                  status === "mastered"
                    ? "bg-ok-soft/50 border-mastery-mastered/40"
                    : status === "shaky"
                      ? "bg-warn-soft/55 border-mastery-fragile/45"
                      : status === "learning"
                        ? "bg-info-soft/45 border-mastery-learning/40"
                        : "bg-surface-sunken/70 border-line-subtle";

                const tile = (
                  <div
                    data-status={status}
                    data-high-weight={highWeight || undefined}
                    className={clsx(
                      "grid min-w-0 gap-1.5 rounded-md border p-2.5 text-left transition-colors duration-fast ease-out",
                      toneClasses,
                      highWeight && "ring-1 ring-accent/55",
                      onSelectPoint && "hover:border-accent hover:shadow-1",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <MasteryShapeGlyph status={status} size={15} className="mt-0.5" />
                      <span className="text-caption tabular-nums font-medium text-fg-secondary">
                        {pct}%
                      </span>
                    </div>
                    <span className="line-clamp-2 text-ui font-medium text-fg-primary">
                      {point.name}
                    </span>
                    <span className="text-caption text-fg-tertiary">
                      {statusLabels[status]}
                    </span>
                  </div>
                );

                return onSelectPoint ? (
                  <button
                    key={point.id}
                    type="button"
                    data-testid={`mastery-tile-${point.id}`}
                    aria-label={`${point.name} · ${statusLabels[status]} · ${pct}%`}
                    onClick={() => onSelectPoint(point)}
                    className="min-w-0 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {tile}
                  </button>
                ) : (
                  <div key={point.id} data-testid={`mastery-tile-${point.id}`} className="min-w-0">
                    {tile}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
