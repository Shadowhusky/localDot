// Throwaway S9 probe. No decoding, input, clipboard, client acknowledgements or compression.
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

export function parseSelkiesMessage(data) {
  if (data.length < 12 || data[0] !== 4) return null;
  const flags = data[1],
    payload = data.subarray(12),
    nals = [];
  let codec;
  for (let i = 0; i + 4 < payload.length; i++) {
    let start = 0;
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) start = i + 3;
    else if (
      payload[i] === 0 &&
      payload[i + 1] === 0 &&
      payload[i + 2] === 0 &&
      payload[i + 3] === 1
    )
      start = i + 4;
    if (!start) continue;
    const type = payload[start] & 31;
    nals.push(type);
    if (type === 7 && start + 3 < payload.length)
      codec = `avc1.${payload.subarray(start + 1, start + 4).toString("hex")}`;
    i = start;
  }
  return {
    type: 4,
    flags,
    codecNibble: flags >> 4,
    key: (flags & 15) === 1,
    frameId: data.readUInt16BE(2),
    region: data.readUInt16BE(4),
    width: data.readUInt16BE(6),
    height: data.readUInt16BE(8),
    extra: data.readUInt16BE(10),
    bytes: payload.length,
    nals,
    codec,
    payload,
  };
}
export function runProbe(options) {
  const endpoint = new URL(options.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("Endpoint must be HTTP or HTTPS");
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/websockets`;
  // Match the production viewer proxy; the primary comparison alone uses controller mode.
  endpoint.searchParams.set("role", options.mode === "primary" ? "controller" : "viewer");
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  if (options.dump) {
    const inside = relative(repo, resolve(options.dump));
    if (!(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)))
      throw new Error("Dump directory must be outside the repository");
    mkdirSync(options.dump, { recursive: true });
  }
  const start = performance.now(),
    frames = [],
    transcript = [],
    requests = [],
    keys = [];
  const timers = new Set();
  let bytes = 0,
    ended = false,
    first = null,
    dumpCount = 0;
  const ws = new WebSocket(endpoint, {
    headers: { authorization: options.authorization },
    perMessageDeflate: false,
  });
  const now = () => Math.round((performance.now() - start) * 1000) / 1000;
  const send = (text) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
      transcript.push({ t: now(), direction: "send", text });
    }
  };
  const interval = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.add(t);
    return t;
  };
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.add(t);
    return t;
  };
  let finish;
  const done = new Promise((resolveDone) => {
    finish = (error) => {
      if (ended) return;
      ended = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      ws.terminate();
      const intervals = keys.slice(1).map((t, i) => t - keys[i]);
      const latencies = requests
        .filter((r) => r.latencyMs !== undefined)
        .map((r) => r.latencyMs)
        .sort((a, b) => a - b);
      const span = now();
      const summary = {
        endpoint: options.endpoint,
        startedAtMs: performance.timeOrigin + start,
        mode: options.mode,
        role: endpoint.searchParams.get("role"),
        seconds: span / 1000,
        frames: frames.length,
        keys: keys.length,
        bytes,
        bytesPerSecond: bytes / (span / 1000),
        firstFrameMs: first,
        firstKeyMs: keys[0] ?? null,
        keyIntervalsMs: intervals,
        longestKeyIntervalMs: intervals.length ? Math.max(...intervals) : null,
        keyRequestLatencyMs: {
          count: latencies.length,
          p50: latencies[Math.floor(latencies.length / 2)] ?? null,
          max: latencies.at(-1) ?? null,
        },
        requests,
        formats: [
          ...new Set(frames.map((f) => `${f.codecNibble}:${f.width}x${f.height}:${f.region}`)),
        ],
        allKeysCarryParameterSetsAndIDR: frames
          .filter((f) => f.key)
          .every((f) => [7, 8, 5].every((n) => f.nals.includes(n))),
        transcript,
        framesMetadata: frames,
        error: error ? String(error) : null,
      };
      if (options.out)
        writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
      resolveDone(summary);
    };
  });
  ws.on("open", () => {
    interval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 500);
    if (options.requestKey)
      interval(() => {
        requests.push({ t: now(), kind: "REQUEST_KEYFRAME" });
        send("REQUEST_KEYFRAME");
      }, options.requestKey);
    if (options.restartEvery) interval(() => send("START_VIDEO"), options.restartEvery);
    later(() => finish(), options.seconds * 1000);
  });
  ws.on("message", (data, binary) => {
    if (!binary) {
      const text = data.toString();
      transcript.push({ t: now(), direction: "receive", text });
      if (text === "MODE websockets") {
        if (options.mode === "primary") send(`SETTINGS,${JSON.stringify(options.settings ?? {})}`);
        send("STOP_VIDEO");
        later(() => send("START_VIDEO"), 250);
      }
      return;
    }
    const frame = parseSelkiesMessage(Buffer.from(data));
    if (!frame) return;
    const { payload, ...metadata } = frame;
    const t = now();
    frames.push({ t, ...metadata });
    bytes += frame.bytes;
    if (first === null) first = t;
    if (frame.key) {
      keys.push(t);
      for (const request of requests)
        if (request.latencyMs === undefined) request.latencyMs = t - request.t;
      if (options.dump && dumpCount++ < 3)
        writeFileSync(resolve(options.dump, `key-${dumpCount}.h264`), payload, { mode: 0o600 });
    }
  });
  ws.on("error", (e) => finish(e.message));
  ws.on("close", (code) => {
    if (!ended) finish(`closed ${code}`);
  });
  later(() => {
    if (ws.readyState !== WebSocket.OPEN) finish("connection timeout");
  }, 10000);
  return { done, send, close: () => finish(), socket: ws };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage =
    "probe.mjs --endpoint http://127.0.0.1:port --authorization 'Basic ...' --seconds n --mode shared|primary [--request-key ms|off] [--restart-every ms] [--out file] [--dump outside-repo-dir]";
  if (args.includes("--help")) console.log(usage);
  else {
    const opts = Object.fromEntries(
      Array.from({ length: Math.ceil(args.length / 2) }, (_, i) => [
        args[i * 2]?.slice(2),
        args[i * 2 + 1],
      ]),
    );
    const seconds = Number(opts.seconds ?? 10),
      requestKey = opts["request-key"] === "off" ? 0 : Number(opts["request-key"] ?? 0),
      restartEvery = Number(opts["restart-every"] ?? 0);
    if (
      !opts.endpoint ||
      !opts.authorization ||
      !["shared", "primary"].includes(opts.mode) ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 320 ||
      !Number.isFinite(requestKey) ||
      (requestKey !== 0 && requestKey < 500) ||
      !Number.isFinite(restartEvery) ||
      restartEvery < 0
    )
      throw new Error(usage);
    const probe = runProbe({ ...opts, seconds, requestKey, restartEvery });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => probe.close());
    const result = await probe.done;
    console.log(
      JSON.stringify({
        frames: result.frames,
        keys: result.keys,
        firstKeyMs: result.firstKeyMs,
        formats: result.formats,
        error: result.error,
      }),
    );
    if (result.error) process.exitCode = 1;
  }
}
