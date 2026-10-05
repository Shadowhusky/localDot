// Records a synthetic stream into argv[2] and prints "<index> <µs>" after every push that resolved,
// so a test can SIGKILL it at an arbitrary frame (Review Focus 2).
import { synthFrame } from "@localdot/stage/testing";
import { RecordingWriter } from "../writer.ts";
import { CRASH_FORMAT, CRASH_SYNTH, crashArrival } from "./crash-stream.ts";

const writer = new RecordingWriter({ dir: process.argv[2] as string, ...CRASH_FORMAT });
await writer.start();
for (let i = 0; ; i++) {
  const f = synthFrame(CRASH_SYNTH, i);
  const t = crashArrival(i);
  await writer.push({ tMicros: t, key: f.key, data: f.data });
  process.stdout.write(`${i} ${t}\n`);
  if (i % 45 === 44) await writer.flushIdle(t + 500_000);
}
