import Link from "next/link";
import type { ReactNode } from "react";

type BadgeTone = "default" | "good" | "warn" | "muted";

export function StatusBadge({ label, tone = "default" }: { label: string; tone?: BadgeTone }) {
  return <span className={`status-badge tone-${tone}`}>{label}</span>;
}

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="hero-card">
      <div className="hero-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted hero-lede">{description}</p>
        {actions ? <div className="hero-actions">{actions}</div> : null}
      </div>
      {aside ? <div className="hero-side">{aside}</div> : null}
    </section>
  );
}

export function SectionCard({
  title,
  eyebrow,
  hint,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel inset-panel">
      <div className="section-heading">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
          {hint ? <p className="muted section-hint">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <article className="metric-card">
      <p className="muted">{label}</p>
      <strong className="stat-value">{value}</strong>
      {detail ? <p>{detail}</p> : null}
    </article>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-copy"><strong>{title}</strong><span className="muted">{description}</span></span>
      {action}
    </div>
  );
}

export function ErrorCallout({ message }: { message: string }) {
  return <p className="error-callout" role="alert">{message}</p>;
}

export function LoadingState({ label = "正在读取..." }: { label?: string }) {
  return (
    <div className="muted loading-state" role="status" aria-live="polite">
      <span>{label}</span>
    </div>
  );
}

export function PropertyList({
  entries,
}: {
  entries: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="meta-list wide">
      {entries.map(({ label, value }) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function QuickLink({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="quick-link-card">
      <strong>{title}</strong>
      <p>{description}</p>
    </Link>
  );
}
