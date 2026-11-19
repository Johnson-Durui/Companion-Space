import type { Block } from "./types";

export function boardMarkdown(blocks: readonly Block[]): string {
  const fence = (content: string, language = "") => {
    const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
    const ticks = "`".repeat(longest + 1);
    return `${ticks}${language}\n${content.trimEnd()}\n${ticks}`;
  };
  return blocks.map(({ type, content, title }) => {
    const before = title ? `### ${title}\n\n` : "";
    if (["code", "plot", "image", "diagram"].includes(type)) {
      const language = type === "diagram" ? "mermaid" : ["plot", "image"].includes(type) ? "json" : "";
      return before + fence(content, language);
    }
    if (type === "math" || type === "steps") {
      return before + content.split("\n").filter(Boolean)
        .map((line) => `$$\n${line.replace(/^\$+|\$+$/g, "")}\n$$`).join("\n\n");
    }
    return before + content;
  }).join("\n\n") + "\n";
}

