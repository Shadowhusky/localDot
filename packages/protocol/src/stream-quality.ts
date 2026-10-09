import { z } from "zod";

// A viewer's wish for the stream of the computer it watches, sent over its stream socket. The
// daemon's relay keeps it and never passes it to the computer: one capture serves every viewer, so
// the daemon sets it for all of them (apps/daemon/src/cells/stream-tuning.ts).
export const STREAM_QUALITY_VERB = "_ld_q";

export const StreamQuality = z.object({
  framerate: z.number().int().min(1).max(60),
  // x264's constant rate factor: higher is a smaller, softer picture.
  crf: z.number().int().min(10).max(51),
});
export type StreamQuality = z.infer<typeof StreamQuality>;

// A hidden page asks for nothing; a visible one names the quality it can take.
export const StreamQualityReport = z.union([
  z.object({ visible: z.literal(false) }).strict(),
  StreamQuality.extend({ visible: z.literal(true) }).strict(),
]);
export type StreamQualityReport = z.infer<typeof StreamQualityReport>;

export function qualityMessage(report: StreamQualityReport): string {
  return `${STREAM_QUALITY_VERB},${JSON.stringify(report)}`;
}

// The report a socket message carries, null when it is malformed, or undefined when the message is
// not one.
export function parseQualityMessage(text: string): StreamQualityReport | null | undefined {
  if (!text.startsWith(`${STREAM_QUALITY_VERB},`)) return undefined;
  try {
    const parsed = StreamQualityReport.safeParse(
      JSON.parse(text.slice(STREAM_QUALITY_VERB.length + 1)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
