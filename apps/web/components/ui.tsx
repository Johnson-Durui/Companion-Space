import { Alert, Descriptions, Empty, Spin, Statistic, Tag } from "antd";
import Link from "next/link";
import type { ReactNode } from "react";

type BadgeTone = "default" | "good" | "warn" | "muted";

export function StatusBadge({ label, tone = "default" }: { label: string; tone?: BadgeTone }) {
  return <Tag className={`status-badge tone-${tone}`}>{label}</Tag>;
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
      <Statistic title={label} value={value} />
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
    <Empty
      className="empty-state"
      image={<span className="empty-state-symbol" aria-hidden="true" />}
      description={
        <span className="empty-state-copy">
          <strong>{title}</strong>
          <span className="muted">{description}</span>
        </span>
      }
    >
      {action}
    </Empty>
  );
}

export function ErrorCallout({ message }: { message: string }) {
  return <Alert className="error-callout" type="error" message={message} showIcon role="alert" />;
}

export function LoadingState({ label = "正在读取..." }: { label?: string }) {
  return (
    <div className="muted loading-state" role="status" aria-live="polite">
      <Spin size="small" />
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
    <Descriptions
      className="meta-list wide"
      bordered
      colon={false}
      column={{ xs: 1, sm: 1, md: 2 }}
      layout="vertical"
      size="small"
      items={entries.map((entry) => ({
        key: entry.label,
        label: entry.label,
        children: entry.value,
      }))}
    />
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
