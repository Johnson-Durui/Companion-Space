export interface StudyDayEntry {
  day: string;
  evidence_count: number;
}

export interface WeeklyMinutesEntry {
  week_start: string;
  minutes: number;
}

function isoDateOffset(base: Date, deltaDays: number): string {
  const copy = new Date(base.getFullYear(), base.getMonth(), base.getDate() + deltaDays);
  const y = copy.getFullYear();
  const m = String(copy.getMonth() + 1).padStart(2, "0");
  const d = String(copy.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function computeStreakDays(days: StudyDayEntry[], today = new Date()): number {
  const active = new Set(days.filter((d) => d.evidence_count > 0).map((d) => d.day.slice(0, 10)));
  if (!active.size) return 0;
  const todayIso = isoDateOffset(today, 0);
  const startOffset = active.has(todayIso) ? 0 : -1;
  let streak = 0;
  for (let offset = startOffset; offset >= -365; offset -= 1) {
    if (active.has(isoDateOffset(today, offset))) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

export function StudyCalendar({
  trend,
  label,
  streakLabel,
  activeDaysLabel,
  emptyLabel,
  today = new Date(),
}: {
  trend: StudyDayEntry[];
  label: string;
  streakLabel: string;
  activeDaysLabel: string;
  emptyLabel: string;
  today?: Date;
}) {
  const byDay = new Map(trend.map((entry) => [entry.day.slice(0, 10), entry.evidence_count]));
  const totalDays = 56;
  const cells = Array.from({ length: totalDays }, (_, idx) => {
    const day = isoDateOffset(today, -(totalDays - 1 - idx));
    const count = byDay.get(day) ?? 0;
    return { day, count, col: Math.floor(idx / 7), row: idx % 7 };
  });
  const activeCount = cells.filter((c) => c.count > 0).length;
  const streak = computeStreakDays(trend, today);

  if (activeCount === 0) {
    return <p className="text-ui text-fg-secondary">{emptyLabel}</p>;
  }

  const cellSize = 14;
  const gap = 4;
  const svgWidth = 8 * cellSize + 7 * gap;
  const svgHeight = 7 * cellSize + 6 * gap;

  return (
    <div className="grid gap-3" data-testid="study-calendar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-secondary">
        <span>{activeDaysLabel.replace("{count}", String(activeCount))}</span>
        <span>{streakLabel.replace("{days}", String(streak))}</span>
      </div>
      <div className="overflow-x-auto">
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`${label} · ${activeDaysLabel.replace("{count}", String(activeCount))} · ${streakLabel.replace("{days}", String(streak))}`}
        >
          {cells.map((cell) => {
            const x = cell.col * (cellSize + gap);
            const y = cell.row * (cellSize + gap);
            const opacity =
              cell.count === 0 ? 1 : cell.count >= 6 ? 1 : cell.count >= 3 ? 0.72 : 0.42;
            return (
              <rect
                key={cell.day}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx="3"
                fill={cell.count > 0 ? "var(--accent)" : "var(--surface-sunken)"}
                fillOpacity={opacity}
              >
                <title>{`${cell.day}: ${cell.count}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export function WeeklyMinutes({
  weeks,
  label,
  unitLabel,
  emptyLabel,
}: {
  weeks: WeeklyMinutesEntry[];
  label: string;
  unitLabel: string;
  emptyLabel: string;
}) {
  const total = weeks.reduce((sum, entry) => sum + entry.minutes, 0);
  if (!weeks.length || total === 0) {
    return <p className="text-ui text-fg-secondary">{emptyLabel}</p>;
  }

  const maxMinutes = Math.max(...weeks.map((w) => w.minutes), 1);
  const svgWidth = 360;
  const svgHeight = 116;
  const chartBottom = 90;
  const maxBarH = 68;
  const colW = svgWidth / weeks.length;

  return (
    <div className="grid gap-2" data-testid="weekly-minutes">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="h-32 w-full max-w-[440px]"
        role="img"
        aria-label={`${label} · ${total} ${unitLabel}`}
      >
        <line
          x1="0"
          y1={chartBottom}
          x2={svgWidth}
          y2={chartBottom}
          stroke="var(--border-subtle)"
          strokeWidth="1"
        />
        {weeks.map((entry, idx) => {
          const barW = Math.min(26, colW * 0.54);
          const x = idx * colW + (colW - barW) / 2;
          const barH = entry.minutes > 0 ? Math.max(6, (entry.minutes / maxMinutes) * maxBarH) : 0;
          const y = chartBottom - barH;
          const shortDate = entry.week_start.slice(5);
          return (
            <g key={entry.week_start}>
              {barH > 0 ? (
                <>
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={barH}
                    rx="4"
                    fill="var(--accent)"
                    fillOpacity={idx === weeks.length - 1 ? 1 : 0.65}
                  />
                  <text
                    x={x + barW / 2}
                    y={y - 5}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--text-secondary)"
                  >
                    {entry.minutes}
                  </text>
                </>
              ) : null}
              <text
                x={x + barW / 2}
                y={chartBottom + 16}
                textAnchor="middle"
                fontSize="10"
                fill="var(--text-tertiary)"
              >
                {shortDate}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
