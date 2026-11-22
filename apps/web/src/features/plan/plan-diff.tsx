import { Badge } from "../../ui";
import t from "../../locales/zh-CN.json";
import type { PlanDiff } from "../learner/api";
import { planItemDisplayTitle } from "./item-kind";

const copy = t.loopViz;

export function hasPlanDiffChanges(diff?: PlanDiff | null): boolean {
  if (!diff) return false;
  return (
    diff.moved_earlier.length > 0 ||
    diff.moved_later.length > 0 ||
    diff.added.length > 0 ||
    diff.deferred.length > 0
  );
}

export function summarizePlanDiff(diff?: PlanDiff | null): string {
  if (!diff || !hasPlanDiffChanges(diff)) return "";
  const parts: string[] = [];
  if (diff.moved_earlier.length) {
    parts.push(`${copy.diffEarlier} ${diff.moved_earlier.map((e) => planItemDisplayTitle(e)).slice(0, 2).join("、")}`);
  }
  if (diff.moved_later.length) {
    parts.push(`${copy.diffLater} ${diff.moved_later.map((e) => planItemDisplayTitle(e)).slice(0, 2).join("、")}`);
  }
  if (diff.added.length) {
    parts.push(`${copy.diffAdded} ${diff.added.map((e) => planItemDisplayTitle(e)).slice(0, 2).join("、")}`);
  }
  if (diff.deferred.length) {
    parts.push(`${copy.diffDeferred} ${diff.deferred.map((e) => e.kp_name).slice(0, 2).join("、")}`);
  }
  return parts.join("；");
}

export function PlanDiffList({ diff, compact = false }: { diff?: PlanDiff | null; compact?: boolean }) {
  if (!diff || !hasPlanDiffChanges(diff)) return null;

  const rows = [
    {
      key: "earlier",
      label: copy.diffEarlier,
      tone: "accent" as const,
      names: diff.moved_earlier.map((entry) => planItemDisplayTitle(entry)),
    },
    {
      key: "added",
      label: copy.diffAdded,
      tone: "ok" as const,
      names: diff.added.map((entry) => planItemDisplayTitle(entry)),
    },
    {
      key: "later",
      label: copy.diffLater,
      tone: "neutral" as const,
      names: diff.moved_later.map((entry) => planItemDisplayTitle(entry)),
    },
    {
      key: "deferred",
      label: copy.diffDeferred,
      tone: "warn" as const,
      names: diff.deferred.map((entry) => entry.kp_name),
    },
  ].filter((row) => row.names.length > 0);

  return (
    <div
      data-testid="plan-diff-list"
      className={compact ? "grid gap-1.5 pt-1" : "grid gap-2 border-t border-line-subtle pt-3"}
    >
      {!compact ? (
        <p className="text-caption font-semibold text-fg-secondary">{copy.planDiffTitle}</p>
      ) : null}
      <ul className="grid gap-1.5">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center gap-2 text-caption text-fg-secondary">
            <Badge tone={row.tone}>{row.label}</Badge>
            <span className="min-w-0 break-words text-fg-primary">{row.names.join("、")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
