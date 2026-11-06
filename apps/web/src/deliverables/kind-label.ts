import {
  fileExtension,
  isPresentation,
  type TextFormat,
  textFormat,
  type ViewerKind,
  viewerKind,
} from "@localdot/protocol";

const TEXT_LABELS: Record<TextFormat, string> = {
  plain: "Text",
  code: "code",
  markdown: "Markdown",
  json: "JSON",
  log: "Log",
};
const LANGUAGES: Record<string, string> = {
  ...Object.fromEntries(["js", "mjs", "cjs", "jsx"].map((e) => [e, "JavaScript"])),
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C header",
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  ...Object.fromEntries(["sh", "bash", "zsh", "fish"].map((e) => [e, "Shell script"])),
  sql: "SQL",
  css: "Stylesheet",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
};

export function kindLabel(name: string): string {
  const ext = fileExtension(name).toUpperCase();
  const kind = viewerKind(name);
  if (kind === "text") {
    const format = textFormat(name);
    return format === "code"
      ? (LANGUAGES[ext.toLowerCase()] ?? `${ext} text`)
      : TEXT_LABELS[format];
  }
  const labels: Record<Exclude<ViewerKind, "text">, string> = {
    picture: `${ext} picture`,
    svg: "SVG picture",
    pdf: "PDF",
    html: "Web page",
    table: `${ext} table`,
    sheet: "Spreadsheet",
    audio: `${ext} audio`,
    video: `${ext} video`,
    page: isPresentation(name) ? `${ext} presentation` : `${ext} document`,
    details: ext ? `${ext} file` : "File",
  };
  return labels[kind];
}
