import katex from "katex";
import { Fragment, useMemo } from "react";
import styles from "./board.module.css";

export function MathBlock({ expression, display = true }: { expression: string; display?: boolean }) {
  const html = useMemo(() => katex.renderToString(expression.slice(0, 4000), {
    displayMode: display,
    throwOnError: false,
    trust: false,
    maxExpand: 128,
    maxSize: 20,
    strict: "ignore",
  }), [display, expression]);
  return <span className={display ? styles.math : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function LessonText({ source }: { source: string }) {
  return source.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => (
    <p key={index}>
      {paragraph.split(/(\$\$[^$]+\$\$|\$[^$\n]+\$|`[^`]+`|\*\*[^*]+\*\*)/).map((part, token) => {
        if (part.startsWith("$$") && part.endsWith("$$")) return <MathBlock key={token} expression={part.slice(2, -2)} />;
        if (part.startsWith("$") && part.endsWith("$") && part.length > 2) return <MathBlock key={token} expression={part.slice(1, -1)} display={false} />;
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={token}>{part.slice(1, -1)}</code>;
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={token}>{part.slice(2, -2)}</strong>;
        return <Fragment key={token}>{part}</Fragment>;
      })}
    </p>
  ));
}
