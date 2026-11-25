import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import { useEffect, useMemo, useState } from "react";
import { DiagramBlock } from "./diagram";
import { boardMarkdown } from "./markdown";
import { LessonText, MathBlock } from "./math";
import { PlotBlock } from "./plot";
import type { Block, BoardMark } from "./types";
import { parseImageSpec } from "./validation";
import styles from "./board.module.css";

for (const [name, language] of Object.entries({ bash, css, java, javascript, json, python, sql, xml })) {
  hljs.registerLanguage(name, language);
}

export type BoardLabels = {
  locate?: string;
  renderError?: string;
  viewSource?: string;
  imageAlt?: string;
  copy?: string;
  copied?: string;
  saveToNote?: string;
  savedToNote?: string;
  zoom?: string;
  plotReset?: string;
  plotPlay?: string;
  plotPause?: string;
};

const defaults: Required<BoardLabels> = {
  locate: "从这一行开始没跟上",
  renderError: "这张图没画出来",
  viewSource: "查看原始内容",
  imageAlt: "课程资料原页",
  copy: "复制",
  copied: "已复制",
  saveToNote: "收进笔记",
  savedToNote: "已收进笔记",
  zoom: "放大查看",
  plotReset: "恢复默认",
  plotPlay: "演示变化",
  plotPause: "暂停演示",
};

export type NormalizedMarkStyle = "underline" | "box" | "color";

export function normalizeMarkStyle(
  style: string | undefined,
  fallback: NormalizedMarkStyle = "underline",
): NormalizedMarkStyle {
  if (style === "underline" || style === "box" || style === "color") return style;
  if (style === "highlight" || style === "fill" || style === "bg") return "color";
  return fallback;
}

export function nextRevealCount(current: number, total: number, reducedMotion: boolean): number {
  if (total <= 0) return 0;
  if (reducedMotion) return total;
  if (current <= 0) return 1;
  return Math.min(total, current + 1);
}

function markToneClass(color?: string): string {
  if (color === "ok") return styles.markToneOk;
  if (color === "warn") return styles.markToneWarn;
  return styles.markToneAccent;
}

function findLatestMark(marks: readonly BoardMark[] | undefined, line?: number): BoardMark | undefined {
  if (!marks?.length) return undefined;
  let match: BoardMark | undefined;
  for (const mark of marks) {
    if (line === undefined ? mark.line === undefined : mark.line === line) {
      match = mark;
    }
  }
  return match;
}

function isMarkStale(
  mark: BoardMark | undefined,
  allMarks: readonly BoardMark[] | undefined,
  latestMarkSeq?: number,
): boolean {
  if (!mark) return false;
  if (latestMarkSeq !== undefined && mark.seq !== undefined) {
    return mark.seq < latestMarkSeq;
  }
  if (!allMarks?.length) return false;
  return allMarks[allMarks.length - 1] !== mark;
}

function canSplitTextLines(content: string): boolean {
  if (!content.trim()) return false;
  // Preserve multi-line markdown tables or fenced code blocks intact
  if (/```/.test(content)) return false;
  if (/^\s*\|.+\|\s*$/m.test(content)) return false;
  return true;
}

function ErrorSource({ source, label, viewSource }: { source: string; label: string; viewSource: string }) {
  return (
    <div className={styles.fallback} role="note">
      <p className={styles.fallbackTitle}>{label}</p>
      <details className={styles.fallbackDetails}>
        <summary>{viewSource}</summary>
        <pre><code>{source}</code></pre>
      </details>
    </div>
  );
}

function CodeBlock({
  block,
  locate,
  labels,
  latestMarkSeq,
}: {
  block: Block;
  locate?: (target: string) => void;
  labels: Required<BoardLabels>;
  latestMarkSeq?: number;
}) {
  const lines = useMemo(() => {
    const html = hljs.highlightAuto(block.content.slice(0, 20_000)).value;
    return html.split("\n");
  }, [block.content]);

  return (
    <pre className={styles.code}>
      <code>
        {lines.map((line, index) => {
          const number = index + 1;
          const mark = findLatestMark(block.marks, number);
          const stale = isMarkStale(mark, block.marks, latestMarkSeq);
          const isPointed = block.point !== undefined && block.pointLine === number;
          const toneClass = mark ? markToneClass(mark.color) : undefined;
          return (
            <span
              key={number}
              className={toneClass ? `${styles.codeLine} ${toneClass}` : styles.codeLine}
              data-board-line={`${block.id}.${number}`}
              data-marked={mark ? "true" : undefined}
              data-mark-style={mark ? normalizeMarkStyle(mark.style, "color") : undefined}
              data-mark-stale={stale ? "true" : undefined}
              data-pointed={isPointed ? "true" : undefined}
            >
              {isPointed ? <span key={String(block.point)} className={styles.linePointer} aria-hidden="true" /> : null}
              <span className={styles.codeLineText} dangerouslySetInnerHTML={{ __html: line || " " }} />
              {locate ? (
                <button
                  type="button"
                  className={styles.locateBtn}
                  data-testid={`locate-${block.id}-${number}`}
                  onClick={() => locate(`${block.id}.${number}`)}
                >
                  {labels.locate}
                </button>
              ) : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function ImageBlock({ source, labels }: { source: string; labels: Required<BoardLabels> }) {
  const spec = parseImageSpec(source);
  if (!spec) return <ErrorSource source={source} label={labels.renderError} viewSource={labels.viewSource} />;
  const src = `/api/v2/materials/${encodeURIComponent(spec.material_id)}/pages/${spec.page}/image`;
  const normalized = spec.bbox?.every((value) => value >= 0 && value <= 1);
  return (
    <figure className={styles.image}>
      <img src={src} alt={labels.imageAlt} loading="lazy" />
      {spec.bbox && normalized ? (
        <span
          aria-hidden="true"
          style={{
            left: `${spec.bbox[0] * 100}%`,
            top: `${spec.bbox[1] * 100}%`,
            width: `${(spec.bbox[2] - spec.bbox[0]) * 100}%`,
            height: `${(spec.bbox[3] - spec.bbox[1]) * 100}%`,
          }}
        />
      ) : null}
    </figure>
  );
}

export interface BoardBlockProps {
  block: Block;
  locate?: (target: string) => void;
  labels?: BoardLabels;
  latestMarkSeq?: number;
  isActiveBlock?: boolean;
  progressiveSteps?: boolean;
  reducedMotion?: boolean;
  showTools?: boolean;
  onZoom?: (block: Block) => void;
  onSaveToNote?: (block: Block) => void;
}

export function BoardBlock({
  block,
  locate,
  labels: provided = {},
  latestMarkSeq,
  isActiveBlock = false,
  progressiveSteps = false,
  reducedMotion = false,
  showTools = false,
  onZoom,
  onSaveToNote,
}: BoardBlockProps) {
  const labels: Required<BoardLabels> = { ...defaults, ...provided };
  const [copied, setCopied] = useState(false);
  const [savedToNote, setSavedToNote] = useState(false);

  const lines = useMemo(
    () => block.content.split("\n").filter((line) => line.length > 0),
    [block.content],
  );
  const isSteps = block.type === "steps";
  const isMath = isSteps || block.type === "math";
  const isText = block.type === "text" && canSplitTextLines(block.content);

  // Progressive line-by-line reveal for multi-step derivations (instant under reducedMotion or non-progressive mode)
  const shouldProgress = isSteps && progressiveSteps && !reducedMotion && lines.length > 1;
  const [revealedCount, setRevealedCount] = useState<number>(() =>
    shouldProgress ? 1 : lines.length,
  );

  useEffect(() => {
    if (!shouldProgress) {
      setRevealedCount(lines.length);
      return;
    }
    setRevealedCount((prev) => {
      if (prev <= 0) return 1;
      return Math.min(prev, lines.length);
    });
  }, [shouldProgress, lines.length]);

  useEffect(() => {
    if (!shouldProgress || revealedCount >= lines.length) return;
    const stepDelayMs = Math.max(45, Math.min(280, Math.floor(1100 / Math.max(1, lines.length - 1))));
    const timer = window.setTimeout(() => {
      setRevealedCount((prev) => nextRevealCount(prev, lines.length, false));
    }, stepDelayMs);
    return () => window.clearTimeout(timer);
  }, [shouldProgress, revealedCount, lines.length]);

  const visibleLines = isSteps && shouldProgress ? lines.slice(0, Math.max(1, revealedCount)) : lines;

  // Whole-block mark (only marks without a specific line target)
  const blockLevelMark = findLatestMark(block.marks, undefined);
  const blockLevelStale = isMarkStale(blockLevelMark, block.marks, latestMarkSeq);
  const blockPointedWhole = block.point !== undefined && block.pointLine === undefined;
  const zoomable = block.type === "plot" || block.type === "diagram" || block.type === "image";

  const handleCopy = () => {
    const textToCopy = boardMarkdown([block]).trim();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(textToCopy).catch(() => undefined);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const handleSaveToNote = () => {
    if (!onSaveToNote) return;
    onSaveToNote(block);
    setSavedToNote(true);
    window.setTimeout(() => setSavedToNote(false), 1800);
  };

  const blockClasses = [
    styles.block,
    blockLevelMark ? markToneClass(blockLevelMark.color) : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={blockClasses}
      data-kind={block.type}
      data-marked={block.mark || undefined}
      data-block-mark-style={blockLevelMark ? normalizeMarkStyle(blockLevelMark.style, "color") : undefined}
      data-block-mark-stale={blockLevelStale ? "true" : undefined}
      data-pointed={blockPointedWhole ? "true" : undefined}
      data-variant={block.variant}
    >
      {blockPointedWhole ? (
        <span key={String(block.point)} className={styles.blockPointer} aria-hidden="true" />
      ) : null}

      {showTools ? (
        <div className={styles.blockTools} data-testid={`block-tools-${block.id}`}>
          <button
            type="button"
            className={styles.toolBtn}
            aria-label={copied ? labels.copied : labels.copy}
            onClick={handleCopy}
          >
            {copied ? labels.copied : labels.copy}
          </button>
          {onSaveToNote ? (
            <button
              type="button"
              className={styles.toolBtn}
              aria-label={savedToNote ? labels.savedToNote : labels.saveToNote}
              data-testid={`save-note-block-${block.id}`}
              onClick={handleSaveToNote}
            >
              {savedToNote ? labels.savedToNote : labels.saveToNote}
            </button>
          ) : null}
          {zoomable && onZoom ? (
            <button
              type="button"
              className={styles.toolBtn}
              aria-label={labels.zoom}
              data-testid={`zoom-block-${block.id}`}
              onClick={() => onZoom(block)}
            >
              {labels.zoom}
            </button>
          ) : null}
        </div>
      ) : null}

      {block.title ? (
        <div className={styles.blockHeader}>
          <h3 className={styles.blockTitle}>{block.title}</h3>
        </div>
      ) : null}

      {isMath
        ? visibleLines.map((line, index) => {
            const number = index + 1;
            const mark = findLatestMark(block.marks, number);
            const stale = isMarkStale(mark, block.marks, latestMarkSeq);
            const isPointed = block.point !== undefined && block.pointLine === number;
            const isActiveStep =
              isSteps &&
              index === visibleLines.length - 1 &&
              (shouldProgress && revealedCount < lines.length ? true : isActiveBlock && block.point === undefined);
            const rowClasses = [styles.lineRow, mark ? markToneClass(mark.color) : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={number}
                className={rowClasses}
                data-board-line={`${block.id}.${number}`}
                data-marked={mark ? "true" : undefined}
                data-mark-style={mark ? normalizeMarkStyle(mark.style, "underline") : undefined}
                data-mark-stale={stale ? "true" : undefined}
                data-pointed={isPointed ? "true" : undefined}
                data-step-active={isActiveStep ? "true" : undefined}
              >
                {isPointed ? (
                  <span key={String(block.point)} className={styles.linePointer} aria-hidden="true" />
                ) : null}
                <div className={styles.lineBody}>
                  <MathBlock
                    expression={line.replace(/^\$+|\$+$/g, "")}
                    errorLabel={labels.renderError}
                    viewSourceLabel={labels.viewSource}
                  />
                </div>
                {locate ? (
                  <button
                    type="button"
                    className={styles.locateBtn}
                    data-testid={`locate-${block.id}-${number}`}
                    onClick={() => locate(`${block.id}.${number}`)}
                  >
                    {labels.locate}
                  </button>
                ) : null}
              </div>
            );
          })
        : null}

      {block.type === "code" ? (
        <CodeBlock
          block={block}
          locate={locate}
          labels={labels}
          latestMarkSeq={latestMarkSeq}
        />
      ) : null}

      {block.type === "diagram" ? (
        <DiagramBlock
          source={block.content}
          errorLabel={labels.renderError}
          viewSourceLabel={labels.viewSource}
        />
      ) : null}

      {block.type === "plot" ? (
        <PlotBlock
          source={block.content}
          errorLabel={labels.renderError}
          viewSourceLabel={labels.viewSource}
          resetLabel={labels.plotReset}
          playLabel={labels.plotPlay}
          pauseLabel={labels.plotPause}
          externalParams={block.paramValues}
          paramSeq={block.paramSeq}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {block.type === "image" ? <ImageBlock source={block.content} labels={labels} /> : null}

      {isText
        ? lines.map((line, index) => {
            const number = index + 1;
            const mark = findLatestMark(block.marks, number);
            const stale = isMarkStale(mark, block.marks, latestMarkSeq);
            const isPointed = block.point !== undefined && block.pointLine === number;
            const rowClasses = [styles.lineRow, mark ? markToneClass(mark.color) : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={number}
                className={rowClasses}
                data-board-line={`${block.id}.${number}`}
                data-marked={mark ? "true" : undefined}
                data-mark-style={mark ? normalizeMarkStyle(mark.style, "underline") : undefined}
                data-mark-stale={stale ? "true" : undefined}
                data-pointed={isPointed ? "true" : undefined}
              >
                {isPointed ? (
                  <span key={String(block.point)} className={styles.linePointer} aria-hidden="true" />
                ) : null}
                <div className={styles.lineBody}>
                  <LessonText source={line} />
                </div>
                {locate ? (
                  <button
                    type="button"
                    className={styles.locateBtn}
                    data-testid={`locate-${block.id}-${number}`}
                    onClick={() => locate(`${block.id}.${number}`)}
                  >
                    {labels.locate}
                  </button>
                ) : null}
              </div>
            );
          })
        : null}

      {!isMath && !isText && !["code", "diagram", "plot", "image"].includes(block.type) ? (
        <LessonText source={block.content} />
      ) : null}
    </article>
  );
}
