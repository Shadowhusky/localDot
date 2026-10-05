import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { recoverRecording } from "./recover.ts";
import { CRASH_FORMAT, CRASH_SYNTH } from "./testing/crash-stream.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHILD = fileURLToPath(new URL("./testing/crash-child.ts", import.meta.url));

// Annex B start codes → NAL payloads (hex), and the same from MP4's 4-byte lengths.
function nalsAnnexB(b: Uint8Array): string[] {
  const out: string[] = [];
  let s = -1;
  for (let i = 0; i + 3 <= b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (s >= 0) out.push(Buffer.from(b.subarray(s, b[i - 1] === 0 ? i - 1 : i)).toString("hex"));
      s = i + 3;
      i += 2;
    }
  }
  if (s >= 0) out.push(Buffer.from(b.subarray(s)).toString("hex"));
  return out;
}
function nalsLengthPrefixed(b: Uint8Array): string[] {
  const out: string[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at + 4 <= b.length; ) {
    const n = v.getUint32(at);
    out.push(Buffer.from(b.subarray(at + 4, at + 4 + n)).toString("hex"));
    at += 4 + n;
  }
  return out;
}

async function recordAndKill(dir: string, killAfter: number): Promise<{ i: number; t: number }[]> {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, dir], {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
  });
  const pushed: { i: number; t: number }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      let requestedKill = false;
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`recording child did not reach ${killAfter} frames within 25 seconds`));
      }, 25_000);
      child.once("error", reject);
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const [i, t] = line.split(" ").map(Number);
          if (
            i === undefined ||
            t === undefined ||
            !Number.isSafeInteger(i) ||
            !Number.isSafeInteger(t)
          ) {
            child.kill("SIGKILL");
            reject(new Error(`invalid recording child receipt: ${line}`));
            return;
          }
          pushed.push({ i, t });
        }
        if (pushed.length >= killAfter && !requestedKill) {
          requestedKill = true;
          child.kill("SIGKILL");
        }
      });
      child.once("close", (code, signal) => {
        if (requestedKill && signal === "SIGKILL") resolve();
        else reject(new Error(`recording child ended before the forced crash: ${code}/${signal}`));
      });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  return pushed;
}

describe("a crash mid-recording (Review Focus 2)", () => {
  for (const killAfter of [3, 31, 97, 200, 333]) {
    it(`keeps every frame whose push resolved when killed after ${killAfter} frames`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "local dot's crash-"));
      directories.push(dir);
      const pushed = await recordAndKill(dir, killAfter);
      expect(pushed.length).toBeGreaterThanOrEqual(killAfter);
      const result = await recoverRecording(dir, CRASH_FORMAT);
      expect(result.state).toBe("recovered");
      const input = new Input({
        source: new FilePathSource(join(dir, "video.mp4")),
        formats: ALL_FORMATS,
      });
      try {
        const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
        const got: { t: number; key: boolean; nals: string[] }[] = [];
        for await (const p of sink.packets())
          got.push({
            t: p.microsecondTimestamp,
            key: p.type === "key",
            nals: nalsLengthPrefixed(p.data),
          });
        expect(got.length).toBeGreaterThanOrEqual(pushed.length);
        for (const { i, t } of pushed) {
          expect(got[i]?.t).toBe(t);
          // Every key frame keeps its sync flag, the recovered tail's included (m1).
          expect(got[i]?.key).toBe(i % CRASH_SYNTH.keyEvery === 0);
          expect(got[i]?.nals).toEqual(nalsAnnexB(synthFrame(CRASH_SYNTH, i).data));
        }
        // Seekable without a walk: the recovered file ends with an mfra.
        const last = pushed.at(-1) as { t: number };
        expect((await sink.getPacket(last.t / 1e6))?.microsecondTimestamp).toBe(last.t);
      } finally {
        input.dispose();
      }
    }, 60_000);
  }
});
