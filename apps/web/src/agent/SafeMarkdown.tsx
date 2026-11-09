// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Wide code and tables scroll sideways, so keyboard users can focus them.
// biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable parsed text has no child state; source position identifies each text span.
import {
  createContext,
  Fragment,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { LocalAddress, PreviewChips } from "../previews/PreviewChip.tsx";
import { Icon } from "../ui/Icon.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { type Block, type Inline, type List, parseMarkdown } from "./markdown.ts";

// While a message streams in, its text is read again at most this often: under the thread's own
// tenth of a second, so each update of the thread reads its text in the same render.
const STREAM_PARSE_MS = 80;

export function linkHost(href: string): string {
  return new URL(href).hostname.replace(/^www\./, "");
}

// The address a link opens, or undefined for one that may not be opened, which shows as plain
// text: its address may carry what the text was written from to whoever made it up.
type LinkRule = (href: string) => string | undefined;
const Links = createContext<LinkRule | undefined>(undefined);

function Unopened({ text, href }: { text: string; href: string }) {
  return (
    <span className="md-unopened">
      {text && text !== href ? `${text} (${linkHost(href)})` : href}
    </span>
  );
}
function LinkView({ node }: { node: Extract<Inline, { kind: "link" }> }) {
  const rule = useContext(Links);
  const href = rule ? rule(node.href) : node.href;
  if (href === undefined) return <Unopened text={node.text} href={node.href} />;
  return (
    <LocalAddress href={href} text={node.text}>
      <span className="md-link">
        <a
          href={href}
          title={href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {node.text}
        </a>
        <span className="md-host">
          <Icon name="share" size={12} />
          {linkHost(href)}
        </span>
      </span>
    </LocalAddress>
  );
}
function ImageView({ node }: { node: Extract<Inline, { kind: "image" }> }) {
  const rule = useContext(Links);
  const href = rule ? rule(node.href) : node.href;
  if (href === undefined) return <Unopened text={node.text || "Image"} href={node.href} />;
  return (
    <a
      className="md-host md-image"
      href={href}
      title={node.text || href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      <Icon name="share" size={12} />
      Image · {linkHost(href)}
    </a>
  );
}

function inlines(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "code")
      return (
        <Fragment key={index}>
          <code>{node.text}</code>
          <PreviewChips text={node.text} limit={1} inline />
        </Fragment>
      );
    if (node.kind === "link") return <LinkView key={index} node={node} />;
    if (node.kind === "image") return <ImageView key={index} node={node} />;
    if (node.kind === "strong") return <strong key={index}>{inlines(node.children)}</strong>;
    return <em key={index}>{inlines(node.children)}</em>;
  });
}

function ListView({ list }: { list: List }) {
  const items = list.items.map((item, index) => (
    <li key={index} data-task={item.task}>
      {item.task && (
        <span
          className="md-box"
          data-done={item.task === "done" || undefined}
          role="img"
          aria-label={item.task === "done" ? "Done" : "To do"}
        >
          {item.task === "done" && <Icon name="check" size={12} />}
        </span>
      )}
      <span className="md-item">{inlines(item.children)}</span>
      {item.list && <ListView list={item.list} />}
    </li>
  ));
  const tasks = list.items.some((item) => item.task) ? "md-tasks" : undefined;
  return list.ordered ? (
    <ol className={tasks} start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul className={tasks}>{items}</ul>
  );
}

function BlockView({ node, announce }: { node: Block; announce?: (text: string) => void }) {
  if (node.kind === "code")
    return (
      <section className="md-code" aria-label={node.language || "Code"}>
        <div className="md-code-head">
          <span className="md-code-language">{node.language || "Code"}</span>
          <CopyButton text={node.text} label="Copy code" announce={announce} />
        </div>
        <pre tabIndex={0}>
          <code>{node.text}</code>
        </pre>
        <PreviewChips text={node.text} />
      </section>
    );
  if (node.kind === "list") return <ListView list={node} />;
  if (node.kind === "heading")
    return node.level <= 2 ? (
      <h3 data-level={node.level}>{inlines(node.children)}</h3>
    ) : node.level === 3 ? (
      <h4 data-level={3}>{inlines(node.children)}</h4>
    ) : (
      <p>
        <strong>{inlines(node.children)}</strong>
      </p>
    );
  if (node.kind === "quote") return <blockquote>{inlines(node.children)}</blockquote>;
  if (node.kind === "rule") return <hr />;
  if (node.kind === "table")
    return (
      <div className="md-table" tabIndex={0}>
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
  return <p data-row={node.pendingRow || undefined}>{inlines(node.children)}</p>;
}

// A block draws again only when its own source changes, so a streaming message redraws its last
// block alone.
const MarkdownBlock = memo(
  BlockView,
  (was, now) =>
    was.node.source === now.node.source &&
    was.node.kind === now.node.kind &&
    was.announce === now.announce,
);

// Text that is still arriving is read again at most every STREAM_PARSE_MS, in the render that
// brings it when it may, so new words cost no render of their own; finished text at once.
function useSettledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => ({ text, at: performance.now() }));
  const now = performance.now();
  const due = streaming && text !== shown.text && now - shown.at >= STREAM_PARSE_MS;
  if (due) setShown({ text, at: now });
  const behind = streaming && !due && text !== shown.text;
  useEffect(() => {
    if (!behind) return;
    const timer = setTimeout(
      () => setShown({ text, at: performance.now() }),
      shown.at + STREAM_PARSE_MS - performance.now(),
    );
    return () => clearTimeout(timer);
  }, [behind, text, shown]);
  return !streaming || due ? text : shown.text;
}

export const SafeMarkdown = memo(function SafeMarkdown({
  text,
  streaming = false,
  compact = false,
  announce,
  shortened = "Message preview shortened.",
  links,
}: {
  text: string;
  // The message is still arriving.
  streaming?: boolean;
  // Where room is short: headings and spacing keep to the surface's own type.
  compact?: boolean;
  announce?(text: string): void;
  // Said under text too long to show whole.
  shortened?: string;
  // The address each link opens, if any; left out, every link opens as written.
  links?: LinkRule;
}) {
  const settled = useSettledText(text, streaming);
  const parsed = useMemo(() => parseMarkdown(settled), [settled]);
  return (
    <Links.Provider value={links}>
      <div className="safe-markdown" data-compact={compact || undefined}>
        {parsed.blocks.map((node, index) => (
          <MarkdownBlock key={index} node={node} announce={announce} />
        ))}
        {parsed.truncated && <p className="thread-note">{shortened}</p>}
      </div>
    </Links.Provider>
  );
});
