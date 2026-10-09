import { canEncodeVideo } from "mediabunny";
import { useEffect, useState } from "react";
import { replayGeometry } from "../replay/recording-source.ts";
import type { ExportContext } from "./export-context.ts";
import type { ExportFormat } from "./export-plan.ts";
import {
  type ExportEnvironment,
  hostEncodable,
  SIZE_CHOICES,
  type SizeChoice,
  sizeOf,
  UNKNOWN_ENVIRONMENT,
} from "./export-settings.ts";
import { probeFrameRate } from "./source-rate.ts";

const CODECS = { mp4: "avc", webm: "vp9" } as const;
// A recording's frame rate is read once per screen while the page stays open.
const rates = new Map<string, Promise<number | null>>();

function rateOf(context: ExportContext): Promise<number | null> {
  if (!context.source.video) return Promise.resolve(null);
  const key = `${context.sessionId}/${context.source.screen ?? "desktop"}`;
  let rate = rates.get(key);
  if (!rate) {
    rate = probeFrameRate(context.source, new AbortController().signal).catch(() => null);
    rates.set(key, rate);
  }
  return rate;
}

export function exportSource(context: ExportContext) {
  const geometry = context.source.geometry ?? replayGeometry(context.model, context.source);
  return geometry ? { w: geometry.w, h: geometry.h } : null;
}

// What this recording and this browser allow, filled in as each check answers. When the host
// makes the video, what it can encode counts instead of this browser.
export function useExportEnvironment(
  context: ExportContext,
  host: Record<ExportFormat, number> | null = null,
): ExportEnvironment {
  const [env, setEnv] = useState<ExportEnvironment>(() => ({
    ...UNKNOWN_ENVIRONMENT,
    source: exportSource(context),
  }));
  const onHost = host !== null;
  useEffect(() => {
    let current = true;
    const base = { ...UNKNOWN_ENVIRONMENT, source: exportSource(context) };
    void rateOf(context).then((sourceRate) => {
      if (current) setEnv((was) => ({ ...was, sourceRate }));
    });
    if (!onHost)
      for (const format of Object.keys(CODECS) as ExportFormat[])
        void Promise.all(
          SIZE_CHOICES.map((choice) => {
            const size = sizeOf(choice, base);
            return canEncodeVideo(CODECS[format], { width: size.w, height: size.h }).catch(
              () => false,
            );
          }),
        ).then((found) => {
          if (!current) return;
          const encodable: Partial<Record<SizeChoice, boolean>> = {};
          SIZE_CHOICES.forEach((choice, index) => {
            encodable[choice] = found[index] === true;
          });
          setEnv((was) => ({ ...was, encodable: { ...was.encodable, [format]: encodable } }));
        });
    return () => {
      current = false;
    };
  }, [context, onHost]);
  return host ? { ...env, encodable: hostEncodable(env, host) } : env;
}
