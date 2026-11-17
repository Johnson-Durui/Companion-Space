import type { Citation } from "@/lib/types";

export function CitationList({ citations }: { citations: Citation[] }) {
  if (!citations.length) {
    return <p className="muted">这一轮没有命中空间资料，或服务端尚未回传引用。</p>;
  }

  return (
    <div className="citation-stack">
      {citations.map((citation) => (
        <details key={`${citation.material_id}-${citation.chunk_id}`} className="citation-card">
          <summary>
            <strong>{citation.title}</strong>
            <span>{citation.locator}</span>
          </summary>
          <p>{citation.excerpt || "服务端没有提供原文片段。"}</p>
        </details>
      ))}
    </div>
  );
}
