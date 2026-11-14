import { type TextFileReply, textFormat, VIEWER_LIMITS, viewerKind } from "@localdot/protocol";
import { lazy, Suspense, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { MediaView } from "./MediaView.tsx";
import { PictureView } from "./PictureView.tsx";
import { ViewerLoading, ViewerMessage } from "./states.tsx";
import { TextBody } from "./TextView.tsx";

const PdfView = lazy(() => import("./PdfView.tsx").then((module) => ({ default: module.PdfView })));

type Text = Extract<TextFileReply, { kind: "text" }>;

// A file's first lines as the computer would send them, or null for one that isn't UTF-8 text. As
// there, a few terminal controls are text, and many are binary data.
export function localText(bytes: Uint8Array, complete: boolean): Text | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete });
  } catch {
    return null;
  }
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && ![9, 10, 12, 13, 27].includes(code)) controls++;
  }
  if (controls > Math.max(2, text.length / 20)) return null;
  const all = text.split(/\r\n|\r|\n/);
  // The line at the cut is partial.
  if (!complete && all.length > 1) all.pop();
  const L = VIEWER_LIMITS;
  const lines = all.slice(0, L.textLines).map((line) => line.slice(0, L.textLineChars));
  const cut = all.length > L.textLines || all.some((line) => line.length > L.textLineChars);
  return { kind: "text", lines, from: "start", truncated: !complete || cut };
}

function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl({ file, url: next });
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url?.file === file ? url.url : null;
}

function useBytes(file: File, max: number): Uint8Array | "failed" | null {
  const [bytes, setBytes] = useState<{ file: File; bytes: Uint8Array | "failed" } | null>(null);
  useEffect(() => {
    let gone = false;
    file
      .slice(0, max)
      .arrayBuffer()
      .then(
        (buffer) => !gone && setBytes({ file, bytes: new Uint8Array(buffer) }),
        () => !gone && setBytes({ file, bytes: "failed" }),
      );
    return () => {
      gone = true;
    };
  }, [file, max]);
  return bytes?.file === file ? bytes.bytes : null;
}

const NoPreview = ({ name }: { name: string }) => (
  <ViewerMessage name={name} title={t`No preview for this kind of file`} />
);

function LocalDrawn({ file, kind }: { file: File; kind: "picture" | "svg" | "audio" | "video" }) {
  const url = useObjectUrl(file);
  if (url === null) return <ViewerLoading label={t`Loading the preview`} />;
  if (kind === "audio" || kind === "video")
    return <MediaView key={url} url={url} kind={kind} name={file.name} />;
  return <PictureView key={url} src={url} name={file.name} />;
}

function LocalPdf({ file }: { file: File }) {
  const bytes = useBytes(file, VIEWER_LIMITS.pdfBytes);
  if (bytes === null) return <ViewerLoading label={t`Loading the PDF`} />;
  if (bytes === "failed")
    return <ViewerMessage name={file.name} title={t`Couldn't load the preview`} />;
  return (
    <Suspense fallback={<ViewerLoading label={t`Loading the PDF`} />}>
      <PdfView data={bytes.slice().buffer} name={file.name} />
    </Suspense>
  );
}

function LocalText({ file }: { file: File }) {
  const bytes = useBytes(file, VIEWER_LIMITS.textBytes);
  if (bytes === null) return <ViewerLoading label={t`Loading the text`} />;
  const reply = bytes === "failed" ? null : localText(bytes, file.size <= bytes.byteLength);
  if (!reply) return <NoPreview name={file.name} />;
  return <TextBody name={file.name} format={textFormat(file.name)} reply={reply} />;
}

// A file attached to a draft, before it is sent: shown from the copy on this device, as the viewer
// shows it once it is on the computer, and anything this browser can't show says so.
export function LocalView({ file }: { file: File }) {
  const kind = viewerKind(file.name);
  if (kind === "picture" || kind === "svg") {
    const cap = kind === "picture" ? VIEWER_LIMITS.pictureBytes : VIEWER_LIMITS.svgBytes;
    return file.size > cap ? (
      <ViewerMessage name={file.name} />
    ) : (
      <LocalDrawn file={file} kind={kind} />
    );
  }
  if (kind === "audio" || kind === "video") return <LocalDrawn file={file} kind={kind} />;
  if (kind === "pdf")
    return file.size > VIEWER_LIMITS.pdfBytes ? (
      <ViewerMessage name={file.name} />
    ) : (
      <LocalPdf file={file} />
    );
  if (kind === "text" || kind === "table" || kind === "html" || kind === "details")
    return <LocalText file={file} />;
  return <NoPreview name={file.name} />;
}
