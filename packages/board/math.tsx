import katex from "katex";
import "katex/dist/katex.min.css";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useMemo } from "react";
import styles from "./board.module.css";

export function MathBlock({ expression, display = true, errorLabel = "Render failed" }: {
  expression: string; display?: boolean; errorLabel?: string;
}) {
  const rendered = useMemo(() => {
    try {
      return { html: katex.renderToString(expression.slice(0, 4000), {
        displayMode: display, throwOnError: true, trust: false, maxExpand: 128, maxSize: 20, strict: "ignore",
      }) };
    } catch { return { html: "", error: true }; }
  }, [display, expression]);
  if (rendered.error) return <span className={styles.fallback}><code>{expression}</code><small>{errorLabel}</small></span>;
  return <span className={display ? styles.math : undefined} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

export function LessonText({ source }: { source: string }) {
  return <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, {
    throwOnError: false, trust: false, strict: "ignore", maxExpand: 128, maxSize: 20,
  }]]}>{source}</Markdown>;
}
