import {
  fileExtension,
  isPresentation,
  type TextFormat,
  textFormat,
  type ViewerKind,
  viewerKind,
} from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";

const TEXT_LABELS: Record<TextFormat, string> = {
  plain: tr("Text"),
  code: tr("code"),
  markdown: "Markdown",
  json: "JSON",
  log: tr("Log"),
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
  h: tr("C header"),
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  ...Object.fromEntries(["sh", "bash", "zsh", "fish"].map((e) => [e, tr("Shell script")])),
  sql: "SQL",
  css: tr("Stylesheet"),
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
      ? (LANGUAGES[ext.toLowerCase()] ?? t`${ext} text`)
      : TEXT_LABELS[format];
  }
  const labels: Record<Exclude<ViewerKind, "text">, string> = {
    picture: t`${ext} picture`,
    svg: tr("SVG picture"),
    pdf: "PDF",
    html: tr("Web page"),
    table: t`${ext} table`,
    sheet: tr("Spreadsheet"),
    audio: t`${ext} audio`,
    video: t`${ext} video`,
    page: isPresentation(name) ? t`${ext} presentation` : t`${ext} document`,
    details: ext ? t`${ext} file` : tr("File"),
  };
  return labels[kind];
}
