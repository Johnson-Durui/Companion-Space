"use client";

/* eslint-disable @next/next/no-img-element -- Mermaid SVG is intentionally isolated in an image context. */

import { Fragment, useEffect, useId, useMemo, useState } from "react";

import type { BoardAction } from "@/lib/types";
import styles from "@/components/lesson/lesson-board.module.css";

/*
 * Source + modification note:
 * This Mermaid loading pattern adapts the useful local dynamic-import approach from
 * HKUDS/DeepTutor `web/components/Mermaid.tsx` (Apache-2.0, commit 740ec413...).
 * Changes here: no Tailwind/i18n/theme coupling, `securityLevel: "strict"` is kept,
 * rendering is wrapped in an explicit invalid-text fallback, and highlight overlays are
 * handled as Companion Space board actions instead of DeepTutor's original UI shell.
 */

export interface BoardFrame {
  action: BoardAction | null;
  baseAction: BoardAction | null;
}

interface LessonBoardProps {
  action: BoardAction | null;
  baseAction?: BoardAction | null;
  compact?: boolean;
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  return tokens
    .filter(Boolean)
    .map((token, index) => {
      const key = `${keyPrefix}-${index}`;
      if (token.startsWith("**") && token.endsWith("**")) {
        return <strong key={key}>{token.slice(2, -2)}</strong>;
      }
      if (token.startsWith("`") && token.endsWith("`")) {
        return <code key={key}>{token.slice(1, -1)}</code>;
      }
      if (token.startsWith("*") && token.endsWith("*")) {
        return <em key={key}>{token.slice(1, -1)}</em>;
      }
      return <Fragment key={key}>{token}</Fragment>;
    });
}

function renderMarkdownBlocks(source: string) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      nodes.push(
        <pre key={`code-${nodes.length}`} className={styles.codeBlock}>
          {language ? <span className={styles.codeLanguage}>{language}</span> : null}
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1]?.length ?? 1);
      const content = headingMatch[2] ?? "";
      const className =
        level === 1 ? styles.h1 : level === 2 ? styles.h2 : level === 3 ? styles.h3 : styles.h4;
      nodes.push(
        <p key={`heading-${nodes.length}`} className={className}>
          {renderInlineMarkdown(content, `heading-${nodes.length}`)}
        </p>,
      );
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ul key={`ul-${nodes.length}`} className={styles.list}>
          {items.map((item, itemIndex) => (
            <li key={`ul-${nodes.length}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ul-${nodes.length}-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ol key={`ol-${nodes.length}`} className={styles.list}>
          {items.map((item, itemIndex) => (
            <li key={`ol-${nodes.length}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ol-${nodes.length}-${itemIndex}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^>\s+/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s+/.test((lines[index] ?? "").trim())) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s+/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote key={`quote-${nodes.length}`} className={styles.quote}>
          {quoteLines.join(" ")}
        </blockquote>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length) {
      const nextLine = (lines[index] ?? "").trimEnd();
      if (
        !nextLine.trim() ||
        nextLine.startsWith("```") ||
        /^#{1,4}\s+/.test(nextLine) ||
        /^[-*]\s+/.test(nextLine.trim()) ||
        /^\d+\.\s+/.test(nextLine.trim()) ||
        /^>\s+/.test(nextLine.trim())
      ) {
        break;
      }
      paragraphLines.push(nextLine);
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${nodes.length}`} className={styles.paragraph}>
        {renderInlineMarkdown(paragraphLines.join(" "), `paragraph-${nodes.length}`)}
      </p>,
    );
  }

  return nodes.length ? nodes : <p className={styles.placeholder}>当前步骤没有可渲染的 Markdown。</p>;
}

function MermaidBoard({ source, compact }: { source: string; compact: boolean }) {
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mermaidId = useId().replaceAll(":", "-");

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const render = async () => {
      setSvgUrl(null);
      setError(null);
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          suppressErrorRendering: true,
        });
        const result = await mermaid.render(`${mermaidId}-graph`, source);
        objectUrl = URL.createObjectURL(
          new Blob([result.svg], { type: "image/svg+xml" }),
        );
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setSvgUrl(objectUrl);
      } catch (renderError) {
        if (!cancelled) {
          setError(
            renderError instanceof Error
              ? renderError.message
              : "Mermaid 渲染失败，已退回文本模式。",
          );
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [mermaidId, source]);

  if (error) {
    return (
      <div className={styles.fallbackCard}>
        <p className={styles.fallbackTitle}>Mermaid 无法渲染，已退回文本板书</p>
        <p className={styles.fallbackMessage}>{error}</p>
        <pre className={styles.rawText}>{source}</pre>
      </div>
    );
  }

  if (!svgUrl) {
    return <p className={styles.placeholder}>正在本地渲染 Mermaid 图表…</p>;
  }

  return (
    <div className={compact ? styles.mermaidCompact : styles.mermaid}>
      <img alt="当前步骤的 Mermaid 板书" src={svgUrl} />
    </div>
  );
}

function HighlightCard({ action }: { action: Extract<BoardAction, { kind: "highlight" }> }) {
  return (
    <div className={styles.highlightCard}>
      <span className={styles.highlightBadge}>重点标注</span>
      {action.target ? <p className={styles.targetText}>目标：{action.target}</p> : null}
      <div className={styles.highlightContent}>{renderMarkdownBlocks(action.content)}</div>
    </div>
  );
}

export function resolveBoardFrame(actions: BoardAction[]): BoardFrame {
  if (!actions.length) {
    return { action: null, baseAction: null };
  }
  const action = actions.at(-1) ?? null;
  if (!action) {
    return { action: null, baseAction: null };
  }
  if (action.kind !== "highlight") {
    return { action, baseAction: null };
  }
  for (let index = actions.length - 2; index >= 0; index -= 1) {
    const candidate = actions[index];
    if (candidate && candidate.kind !== "highlight") {
      return { action, baseAction: candidate };
    }
  }
  return { action, baseAction: null };
}

export function LessonBoard({ action, baseAction = null, compact = false }: LessonBoardProps) {
  const boardClassName = compact ? styles.boardCompact : styles.board;
  const content = useMemo(() => {
    if (!action) {
      return <p className={styles.placeholder}>当前还没有板书内容。</p>;
    }
    if (action.kind === "highlight") {
      return <HighlightCard action={action} />;
    }
    if (action.kind === "mermaid") {
      return <MermaidBoard compact={compact} source={action.content} />;
    }
    return <div className={styles.markdown}>{renderMarkdownBlocks(action.content)}</div>;
  }, [action, compact]);

  if (action?.kind === "highlight") {
    return (
      <div className={`${boardClassName} ${styles.overlayBoard}`}>
        {baseAction ? (
          <div className={styles.baseLayer}>
            <LessonBoard action={baseAction} compact={compact} />
          </div>
        ) : (
          <div className={styles.emptyLayer}>
            <p className={styles.placeholder}>上一张板书不存在，无法叠加高亮。</p>
          </div>
        )}
        <div className={styles.overlayLayer}>{content}</div>
      </div>
    );
  }

  return <div className={boardClassName}>{content}</div>;
}
