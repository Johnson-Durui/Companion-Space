import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import { useMemo } from "react";
import { DiagramBlock } from "./diagram";
import { LessonText, MathBlock } from "./math";
import { PlotBlock } from "./plot";
import type { Block } from "./types";
import { parseImageSpec } from "./validation";
import styles from "./board.module.css";

for (const [name, language] of Object.entries({ bash, css, java, javascript, json, python, sql, xml })) {
  hljs.registerLanguage(name, language);
}

export type BoardLabels = { locate?: string; renderError?: string; imageAlt?: string };
const defaults = { locate: "Locate this line", renderError: "Render failed", imageAlt: "Course material page" };

function ErrorSource({ source, label }: { source: string; label: string }) {
  return <pre className={styles.fallback}><code>{source}</code><small>{label}</small></pre>;
}

function CodeBlock({ block }: { block: Block }) {
  const lines = useMemo(() => {
    const html = hljs.highlightAuto(block.content.slice(0, 20_000)).value;
    return html.split("\n");
  }, [block.content]);
  const marked = new Set(block.marks?.map(({ line }) => line).filter((line): line is number => Boolean(line)));
  return <pre className={styles.code}><code>{lines.map((line, index) => <span key={index} data-marked={marked.has(index + 1) || undefined}
    dangerouslySetInnerHTML={{ __html: line || " " }} />)}</code></pre>;
}

function ImageBlock({ source, labels }: { source: string; labels: Required<BoardLabels> }) {
  const spec = parseImageSpec(source);
  if (!spec) return <ErrorSource source={source} label={labels.renderError} />;
  const src = `/api/v2/materials/${encodeURIComponent(spec.material_id)}/pages/${spec.page}/image`;
  const normalized = spec.bbox?.every((value) => value >= 0 && value <= 1);
  return <figure className={styles.image}>
    <img src={src} alt={labels.imageAlt} loading="lazy" />
    {spec.bbox && normalized ? <span aria-hidden="true" style={{
      left: `${spec.bbox[0] * 100}%`, top: `${spec.bbox[1] * 100}%`,
      width: `${(spec.bbox[2] - spec.bbox[0]) * 100}%`, height: `${(spec.bbox[3] - spec.bbox[1]) * 100}%`,
    }} /> : null}
  </figure>;
}

export function BoardBlock({ block, locate, labels: provided = {} }: {
  block: Block; locate?: (target: string) => void; labels?: BoardLabels;
}) {
  const labels = { ...defaults, ...provided };
  const lines = block.content.split("\n").filter((line) => line.length > 0);
  const math = block.type === "steps" || block.type === "math";
  return <article className={styles.block} data-kind={block.type} data-marked={block.mark || undefined} data-variant={block.variant}>
    {block.point !== undefined ? <span key={block.point} className={styles.pointer} aria-hidden="true" /> : null}
    {block.title ? <h3>{block.title}</h3> : null}
    {math ? lines.map((line, index) => {
      const number = index + 1;
      const expression = <MathBlock expression={line.replace(/^\$+|\$+$/g, "")} errorLabel={labels.renderError} />;
      return locate ? <button className={styles.line} data-marked={block.marks?.some((mark) => mark.line === number) || undefined}
        key={number} type="button" title={labels.locate} onClick={() => locate(`${block.id}.${number}`)}>{expression}</button>
        : <div className={styles.line} data-marked={block.marks?.some((mark) => mark.line === number) || undefined} key={number}>{expression}</div>;
    }) : null}
    {block.type === "code" ? <CodeBlock block={block} /> : null}
    {block.type === "diagram" ? <DiagramBlock source={block.content} errorLabel={labels.renderError} /> : null}
    {block.type === "plot" ? <PlotBlock source={block.content} errorLabel={labels.renderError} /> : null}
    {block.type === "image" ? <ImageBlock source={block.content} labels={labels} /> : null}
    {!math && !["code", "diagram", "plot", "image"].includes(block.type) ? <LessonText source={block.content} /> : null}
  </article>;
}

