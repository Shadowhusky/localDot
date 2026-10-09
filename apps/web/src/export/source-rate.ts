import { EncodedPacketSink } from "mediabunny";
import { openRecording } from "../replay/recording-source.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";

const RATES = [10, 15, 24, 25, 30, 50, 60, 120];
// Pictures further apart than this are a still screen, not the recording's pace.
const STILL_MS = 120;
const SAMPLE_PACKETS = 400;

// The rate a screen recording runs at while something moves: it sends a picture only when the
// screen changes, so the typical gap within a run of changes, not the average, is its frame rate.
export function frameRateOf(timestampsMs: readonly number[]): number | null {
  const gaps: number[] = [];
  for (let index = 1; index < timestampsMs.length; index++) {
    const gap = (timestampsMs[index] ?? 0) - (timestampsMs[index - 1] ?? 0);
    if (gap >= 1 && gap <= STILL_MS) gaps.push(gap);
  }
  if (gaps.length < 8) return null;
  gaps.sort((a, b) => a - b);
  const rate = 1000 / (gaps[Math.floor(gaps.length / 2)] ?? 1000);
  return RATES.reduce((best, each) =>
    Math.abs(each - rate) < Math.abs(best - rate) ? each : best,
  );
}

export async function probeFrameRate(source: ReplaySource, signal: AbortSignal) {
  const input = openRecording(source);
  const abort = () => input.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const packets = new EncodedPacketSink(track);
    const times: number[] = [];
    let packet = await packets.getFirstPacket({ metadataOnly: true });
    while (packet && times.length < SAMPLE_PACKETS && !signal.aborted) {
      times.push(packet.timestamp * 1000);
      packet = await packets.getNextPacket(packet, { metadataOnly: true });
    }
    return signal.aborted ? null : frameRateOf(times);
  } finally {
    signal.removeEventListener("abort", abort);
    input.dispose();
  }
}
