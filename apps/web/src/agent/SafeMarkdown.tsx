// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Named scroll regions require keyboard focus so long output can be scrolled.
// biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable parsed text has no child state; source position identifies each text span.
import { memo, type ReactNode, useMemo } from "react";
import { type Block, type Inline, parseMarkdown } from "./markdown.ts";
import "./output.css";

function inlines(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "code") return <code key={index}>{node.text}</code>;
    if (node.kind === "link")
      return (
        <a
          key={index}
          href={node.href}
          title={node.href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {node.text}
        </a>
      );
    if (node.kind === "strong") return <strong key={index}>{inlines(node.children)}</strong>;
    return <em key={index}>{inlines(node.children)}</em>;
  });
}
function block(node: Block, index: number) {
  if (node.kind === "code")
    return (
      <section
        key={index}
        className="code-block"
        tabIndex={0}
        aria-label={node.language ? `Code (${node.language})` : "Code"}
      >
        <pre>
          <code>{node.text}</code>
        </pre>
      </section>
    );
  if (node.kind === "list") {
    const items = node.items.map((item, i) => <li key={i}>{inlines(item)}</li>);
    return node.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
  }
  if (node.kind === "heading") return <h3 key={index}>{inlines(node.children)}</h3>;
  return <p key={index}>{inlines(node.children)}</p>;
}
export const SafeMarkdown = memo(function SafeMarkdown({ text }: { text: string }) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="safe-markdown">
      {parsed.blocks.map(block)}
      {parsed.truncated && <p className="history-note">Message preview shortened.</p>}
    </div>
  );
});
