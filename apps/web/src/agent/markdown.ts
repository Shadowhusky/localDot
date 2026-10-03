export const MARKDOWN_LIMITS = Object.freeze({
  chars: 20_000,
  nodes: 512,
  depth: 3,
  tokenChars: 4096,
});
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strong" | "em"; children: Inline[] };
export type Block =
  | { kind: "paragraph" | "heading"; children: Inline[] }
  | { kind: "code"; text: string; language: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] };
export function safeMarkdownLink(raw: string): string | null {
  if (
    raw.length > 2048 ||
    !/^https?:\/\//i.test(raw) ||
    [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return null;
  try {
    const url = new URL(raw);
    return url.hostname &&
      !url.username &&
      !url.password &&
      ["http:", "https:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function parseMarkdown(raw: string): { blocks: Block[]; truncated: boolean } {
  let remaining = MARKDOWN_LIMITS.nodes;
  const input = raw.slice(0, MARKDOWN_LIMITS.chars).toWellFormed();
  const inline = (text: string, depth = 0): Inline[] => {
    if (depth >= MARKDOWN_LIMITS.depth || remaining <= 0) return [{ kind: "text", text }];
    const result: Inline[] = [];
    let plain = "",
      attempts = 0;
    const flush = () => {
      if (plain) {
        result.push({ kind: "text", text: plain });
        remaining--;
        plain = "";
      }
    };
    for (let i = 0; i < text.length; ) {
      if (remaining <= 1 || attempts > MARKDOWN_LIMITS.nodes) {
        plain += text.slice(i);
        break;
      }
      const rest = text.slice(i, i + MARKDOWN_LIMITS.tokenChars);
      const image = rest.startsWith("!["),
        link = image || rest.startsWith("[");
      if (link) {
        attempts++;
        const middle = rest.indexOf("](", image ? 2 : 1);
        if (middle >= 0 && middle <= 512) {
          const end = rest.indexOf(")", middle + 2);
          if (end > middle && end - middle <= 2050) {
            const rawLink = rest.slice(0, end + 1),
              href = image ? null : safeMarkdownLink(rest.slice(middle + 2, end));
            if (href) {
              flush();
              result.push({ kind: "link", text: rest.slice(1, middle), href });
              remaining--;
            } else plain += rawLink;
            i += end + 1;
            continue;
          }
        }
      }
      const marker =
        rest.startsWith("**") || rest.startsWith("__")
          ? rest.slice(0, 2)
          : rest[0] === "`" ||
              rest[0] === "*" ||
              (rest[0] === "_" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))
            ? rest[0]
            : null;
      if (marker) {
        attempts++;
        const end = rest.indexOf(marker, marker.length);
        if (end > marker.length) {
          flush();
          const content = rest.slice(marker.length, end);
          if (marker === "`") result.push({ kind: "code", text: content });
          else
            result.push({
              kind: marker.length === 2 ? "strong" : "em",
              children: inline(content, depth + 1),
            });
          remaining--;
          i += end + marker.length;
          continue;
        }
      }
      if (rest[0] === "\\" && /[\\`*_[\]!]/.test(rest[1] ?? "")) {
        plain += rest[1];
        i += 2;
      } else {
        plain += text[i] ?? "";
        i++;
      }
    }
    flush();
    return result;
  };
  const lines = input.replace(/\r\n?/g, "\n").split("\n"),
    blocks: Block[] = [];
  let position = 0;
  while (position < lines.length && remaining > 1) {
    const line = lines[position] ?? "";
    if (!line.trim()) {
      position++;
      continue;
    }
    const fence =
      line.length <= 128 ? /^ {0,3}(`{3,}|~{3,})([a-zA-Z0-9_-]{0,32})\s*$/.exec(line) : null;
    if (fence) {
      const marker = fence[1] ?? "```",
        body: string[] = [];
      position++;
      while (position < lines.length) {
        const next = lines[position] ?? "";
        position++;
        if (next.trim().length >= marker.length && [...next.trim()].every((c) => c === marker[0]))
          break;
        body.push(next);
      }
      blocks.push({ kind: "code", text: body.join("\n"), language: fence[2] ?? "" });
      remaining--;
      continue;
    }
    const list = /^ {0,3}([-+*]|[0-9]{1,6}[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /^[0-9]/.test(list[1] ?? ""),
        items: Inline[][] = [];
      while (position < lines.length && remaining > 1) {
        const next = /^ {0,3}([-+*]|[0-9]{1,6}[.)])\s+(.+)$/.exec(lines[position] ?? "");
        if (!next || /^[0-9]/.test(next[1] ?? "") !== ordered) break;
        items.push(inline(next[2] ?? ""));
        position++;
        remaining--;
      }
      blocks.push({ kind: "list", ordered, items });
      remaining--;
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", children: inline(heading[1] ?? "") });
      position++;
      remaining--;
      continue;
    }
    const paragraph = [line];
    position++;
    while (
      position < lines.length &&
      (lines[position] ?? "").trim() &&
      !/^( {0,3}(`{3}|~{3}|[-+*]\s|[0-9]{1,6}[.)]\s)|#{1,6}\s)/.test(lines[position] ?? "")
    )
      paragraph.push(lines[position++] ?? "");
    blocks.push({ kind: "paragraph", children: inline(paragraph.join("\n")) });
    remaining--;
  }
  if (position < lines.length)
    blocks.push({
      kind: "paragraph",
      children: [{ kind: "text", text: lines.slice(position).join("\n") }],
    });
  return { blocks, truncated: raw.length > MARKDOWN_LIMITS.chars };
}
