import type { InboxItem, ToolContent, ToolResult, TranscriptMessage } from "@localdot/protocol";
import type { ModelMessage, ToolResultPart } from "ai";

// Spec "Harness rules": only the latest three screenshots stay in context. Older ones, and every
// screenshot in the stored transcript, become a marker naming their frame, so a restarted brain can
// fetch the newest again.
export const KEEP_SCREENSHOTS = 3;
// Pictures from the web are never screenshots: the newest few stay apart from them, older ones and
// stored ones become a note of where they came from, and no action is ever based on one.
export const KEEP_PICTURES = 4;
const MARKER =
  /^\[\[localdot:frame ([0-9A-HJKMNP-TV-Z]{26})(?: region (\d+),(\d+),(\d+),(\d+))?\]\]$/;

export interface FrameRef {
  frameId: string;
  region?: { x: number; y: number; w: number; h: number };
}

export function frameMarker(ref: FrameRef): string {
  const r = ref.region;
  return `[[localdot:frame ${ref.frameId}${r ? ` region ${r.x},${r.y},${r.w},${r.h}` : ""}]]`;
}

export function parseMarker(text: string): FrameRef | undefined {
  const m = MARKER.exec(text);
  if (!m) return undefined;
  return {
    frameId: m[1] as string,
    ...(m[2] !== undefined
      ? {
          region: {
            x: Number(m[2]),
            y: Number(m[3]),
            w: Number(m[4]),
            h: Number(m[5]),
          },
        }
      : {}),
  };
}

interface ImagePart {
  type: "file";
  data: { type: "data"; data: string };
  mediaType: string;
  providerOptions: { localdot: { frame: string } };
}

export function imagePart(ref: FrameRef, base64: string): ImagePart {
  return {
    type: "file",
    data: { type: "data", data: base64 },
    mediaType: "image/png",
    providerOptions: { localdot: { frame: frameMarker(ref) } },
  };
}

const isImage = (p: unknown): p is ImagePart =>
  typeof p === "object" &&
  p !== null &&
  (p as ImagePart).type === "file" &&
  typeof (p as ImagePart).providerOptions?.localdot?.frame === "string";

interface PicturePart {
  type: "file";
  data: { type: "data"; data: string };
  mediaType: string;
  providerOptions: { localdot: { picture: string } };
}

export function picturePart(url: string, base64: string): PicturePart {
  return {
    type: "file",
    data: { type: "data", data: base64 },
    mediaType: "image/jpeg",
    providerOptions: { localdot: { picture: `(A picture from ${url} was shown here.)` } },
  };
}

const isPicture = (p: unknown): p is PicturePart =>
  typeof p === "object" &&
  p !== null &&
  (p as PicturePart).type === "file" &&
  typeof (p as PicturePart).providerOptions?.localdot?.picture === "string";

// Every content array an image can sit in: a user message's content, and a tool result's
// content output.
function contentArrays(m: ModelMessage): unknown[][] {
  if (m.role === "user" && Array.isArray(m.content)) return [m.content as unknown[]];
  if (m.role === "tool") {
    return m.content.flatMap((p) =>
      p.type === "tool-result" && p.output.type === "content" ? [p.output.value as unknown[]] : [],
    );
  }
  return [];
}

// A copy with every screenshot but the newest `keep` turned into its marker, and every picture but
// the newest `pictures` into its note.
export function pruneScreenshots(
  messages: ModelMessage[],
  keep = KEEP_SCREENSHOTS,
  pictures = KEEP_PICTURES,
): ModelMessage[] {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError("Invalid screenshot count");
  if (!Number.isSafeInteger(pictures) || pictures < 0)
    throw new RangeError("Invalid picture count");
  const copy = structuredClone(messages);
  let seen = 0;
  let seenPictures = 0;
  for (let i = copy.length - 1; i >= 0; i--) {
    for (const arr of contentArrays(copy[i] as ModelMessage).reverse()) {
      for (let j = arr.length - 1; j >= 0; j--) {
        const part = arr[j];
        if (isPicture(part)) {
          seenPictures += 1;
          if (seenPictures > pictures)
            arr[j] = { type: "text", text: part.providerOptions.localdot.picture };
          continue;
        }
        if (!isImage(part)) continue;
        seen += 1;
        if (seen > keep) arr[j] = { type: "text", text: part.providerOptions.localdot.frame };
      }
    }
  }
  return copy;
}

// The stored form: no image data at all.
export function toTranscript(messages: ModelMessage[]): TranscriptMessage[] {
  return pruneScreenshots(messages, 0, 0).map((m) => {
    if (m.role === "system") throw new Error("System prompts are not transcript messages");
    return { role: m.role, content: m.content };
  });
}

// The stored transcript back into messages: compaction entries replace what they summarized, and
// the newest `keep` markers are fetched again as images.
export async function fromTranscript(
  stored: TranscriptMessage[],
  fetchFrame: (ref: FrameRef) => Promise<string | undefined>,
  keep = KEEP_SCREENSHOTS,
  signal?: AbortSignal,
): Promise<ModelMessage[]> {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError("Invalid screenshot count");
  signal?.throwIfAborted();
  let messages: ModelMessage[] = [];
  for (const s of stored) {
    // Private compaction metadata is a structured record, never a magic string that a user or
    // a model can accidentally put into ordinary message text. Inbox records remain untouched.
    const entry = s.content as {
      type?: unknown;
      replaced?: unknown;
      summary?: unknown;
    } | null;
    if (
      s.role === "user" &&
      !s.sourceInbox &&
      entry &&
      typeof entry === "object" &&
      entry.type === "localdot-compaction" &&
      Object.keys(entry).sort().join(",") === "replaced,summary,type" &&
      Number.isSafeInteger(entry.replaced) &&
      (entry.replaced as number) > 0 &&
      (entry.replaced as number) <= messages.length &&
      typeof entry.summary === "string"
    ) {
      messages = [compactionMessage(entry.summary), ...messages.slice(entry.replaced as number)];
      continue;
    }
    // Explicitly drop sourceInbox outside model content; clone so restoration cannot mutate the
    // durable records used by the loop to deduplicate inbox replay and acknowledge delivery.
    messages.push({
      role: s.role,
      content: structuredClone(s.content),
    } as ModelMessage);
  }
  let restored = 0;
  for (let i = messages.length - 1; i >= 0 && restored < keep; i--) {
    for (const arr of contentArrays(messages[i] as ModelMessage).reverse()) {
      for (let j = arr.length - 1; j >= 0 && restored < keep; j--) {
        const part = arr[j] as { type?: string; text?: string };
        const ref = part.type === "text" && part.text ? parseMarker(part.text) : undefined;
        if (!ref) continue;
        restored += 1; // Bound attempts to the newest slots, including unavailable frames.
        signal?.throwIfAborted();
        let data: string | undefined;
        try {
          data = await fetchFrame(ref);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && error.name === "AbortError") throw error;
        }
        signal?.throwIfAborted();
        if (data) arr[j] = imagePart(ref, data);
      }
    }
  }
  return messages;
}

export function compactionEntry(replaced: number, summary: string): TranscriptMessage {
  if (!Number.isSafeInteger(replaced) || replaced <= 0)
    throw new RangeError("Invalid compaction count");
  return {
    role: "user",
    content: { type: "localdot-compaction", replaced, summary },
  };
}

// A daemon ToolResult as the AI SDK's tool result, and, for clients whose tool results cannot
// carry images, the user message that carries them instead.
export function resultParts(
  callId: string,
  toolName: string,
  result: ToolResult,
  imagesInResults: boolean,
): { part: ToolResultPart; images: (ImagePart | PicturePart)[] } {
  const texts: string[] = [];
  const images: (ImagePart | PicturePart)[] = [];
  const value: ({ type: "text"; text: string } | ImagePart | PicturePart)[] = [];
  for (const c of result.content as ToolContent[]) {
    if (c.type === "text") {
      texts.push(c.text);
      value.push({ type: "text", text: c.text });
      continue;
    }
    const img =
      c.type === "web_image"
        ? picturePart(c.url, c.data)
        : imagePart({ frameId: c.frameId, ...(c.region ? { region: c.region } : {}) }, c.data);
    images.push(img);
    value.push(img);
  }
  if (!result.ok && texts.length === 0) texts.push("The tool failed.");
  if (imagesInResults) {
    return {
      part: {
        type: "tool-result",
        toolCallId: callId,
        toolName,
        output: result.ok
          ? { type: "content", value: value as never }
          : { type: "error-text", value: texts.join("\n") },
      },
      images: result.ok ? [] : images,
    };
  }
  const note = images.length
    ? `${texts.join("\n")}${texts.length ? "\n" : ""}(${images.some(isPicture) ? "images" : "screenshot"} in the next message)`
    : texts.join("\n") || "Done.";
  return {
    part: {
      type: "tool-result",
      toolCallId: callId,
      toolName,
      output: result.ok ? { type: "text", value: note } : { type: "error-text", value: note },
    },
    images,
  };
}

// Characters and screenshots, roughly in tokens: what decides when to compact.
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  let images = 0;
  const walk = (v: unknown) => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (isImage(v) || isPicture(v)) images += 1;
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  for (const m of messages) walk(m.content);
  return Math.ceil(chars / 3.5) + images * 1600;
}

// Where older turns can be cut without separating a tool call from its result: before an
// assistant message whose predecessor is not an assistant message.
export function safeCut(messages: ModelMessage[], target: number): number {
  if (!Number.isSafeInteger(target) || target < 0) throw new RangeError("Invalid history cut");
  for (let i = Math.min(target, messages.length - 1); i > 0; i--) {
    if (messages[i]?.role === "assistant" && messages[i - 1]?.role !== "assistant") return i;
  }
  return 0;
}

// The loop appends this record durably before acknowledging its seq. It does not add this
// metadata to ModelMessage; ordinary text must remain exact for the daemon's acknowledgement pin.
export function inboxTranscript(item: InboxItem): TranscriptMessage | undefined {
  if (item.kind === "resume") return undefined;
  return {
    role: "user",
    content: item.text ?? "",
    sourceInbox: { seq: item.seq, messageId: item.messageId },
  };
}

// Only pixels actually retained in the submitted prompt can authorize an action basis. A crop
// cannot authorize full-screen coordinates, and a text marker does not show the model an image.
export function newestFullFrame(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const arr of contentArrays(messages[i] as ModelMessage).reverse()) {
      for (let j = arr.length - 1; j >= 0; j--) {
        const part = arr[j];
        if (
          !isImage(part) ||
          part.mediaType !== "image/png" ||
          part.data?.type !== "data" ||
          typeof part.data.data !== "string" ||
          part.data.data.length === 0
        )
          continue;
        const ref = parseMarker(part.providerOptions.localdot.frame);
        if (ref && !ref.region) return ref.frameId;
      }
    }
  }
  return undefined;
}

export function compactionMessage(summary: string): ModelMessage {
  const escaped = summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    role: "user",
    content: `<untrusted source="history-summary">\n${escaped}\n</untrusted>`,
  };
}
