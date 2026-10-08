// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Wide code and tables scroll sideways, so keyboard users can focus them.
// biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable parsed text has no child state; source position identifies each text span.
import { memo, type ReactNode, useMemo } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { type Block, type Inline, parseMarkdown } from "./markdown.ts";

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

function block(node: Block, index: number, announce?: (text: string) => void) {
  if (node.kind === "code")
    return (
      <section key={index} className="md-code" aria-label={node.language || "Code"}>
        <div className="md-code-head">
          <span className="md-code-language">{node.language || "Code"}</span>
          <CopyButton text={node.text} label="Copy code" announce={announce} />
        </div>
        <pre tabIndex={0}>
          <code>{node.text}</code>
        </pre>
      </section>
    );
  if (node.kind === "list") {
    const items = node.items.map((item, i) => <li key={i}>{inlines(item)}</li>);
    return node.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
  }
  if (node.kind === "heading")
    return node.level <= 2 ? (
      <h3 key={index}>{inlines(node.children)}</h3>
    ) : (
      <h4 key={index}>{inlines(node.children)}</h4>
    );
  if (node.kind === "quote") return <blockquote key={index}>{inlines(node.children)}</blockquote>;
  if (node.kind === "rule") return <hr key={index} />;
  if (node.kind === "table")
    return (
      <div key={index} className="md-table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {node.head.map((cell, i) => (
                <th key={i} scope="col" data-align={node.align[i] ?? undefined}>
                  {inlines(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} data-align={node.align[i] ?? undefined}>
                    {inlines(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return <p key={index}>{inlines(node.children)}</p>;
}

export const SafeMarkdown = memo(function SafeMarkdown({
  text,
  announce,
}: {
  text: string;
  announce?(text: string): void;
}) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="safe-markdown">
      {parsed.blocks.map((node, index) => block(node, index, announce))}
      {parsed.truncated && <p className="thread-note">Message preview shortened.</p>}
    </div>
  );
});
