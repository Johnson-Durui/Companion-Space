import { ArrowRight } from "../icons";

export interface ChainNode {
  id: string;
  name: string;
}

export function PrereqChain({
  prereqs,
  current,
  dependents,
  prereqLabel,
  dependentLabel,
  emptyLabel,
  onSelect,
}: {
  prereqs: ChainNode[];
  current: ChainNode;
  dependents: ChainNode[];
  prereqLabel: string;
  dependentLabel: string;
  emptyLabel?: string;
  onSelect?: (id: string) => void;
}) {
  if (!prereqs.length && !dependents.length) {
    return emptyLabel ? <p className="text-caption text-fg-tertiary">{emptyLabel}</p> : null;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-line-subtle bg-surface-page px-3.5 py-2.5 text-caption"
      data-testid="prereq-chain"
      aria-label={`${prereqLabel} ${current.name} ${dependentLabel}`}
    >
      {prereqs.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-fg-tertiary">{prereqLabel}</span>
            {prereqs.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect?.(node.id)}
                className="inline-flex min-h-7 items-center rounded-sm border border-line-default bg-surface-card px-2 py-0.5 font-medium text-fg-secondary transition-colors hover:border-accent hover:text-accent-strong"
              >
                {node.name}
              </button>
            ))}
          </div>
          <ArrowRight size={14} className="shrink-0 text-fg-tertiary" aria-hidden="true" />
        </>
      ) : null}

      <span className="inline-flex min-h-7 items-center rounded-sm border border-accent bg-accent-soft px-2.5 py-0.5 font-semibold text-accent-strong">
        {current.name}
      </span>

      {dependents.length > 0 ? (
        <>
          <ArrowRight size={14} className="shrink-0 text-fg-tertiary" aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-fg-tertiary">{dependentLabel}</span>
            {dependents.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect?.(node.id)}
                className="inline-flex min-h-7 items-center rounded-sm border border-line-default bg-surface-card px-2 py-0.5 font-medium text-fg-secondary transition-colors hover:border-accent hover:text-accent-strong"
              >
                {node.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
