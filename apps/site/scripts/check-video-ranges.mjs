import assert from "node:assert/strict";
import { demoResponse } from "../src/worker.ts";
const response = () =>
  new Response(
    Uint8Array.from({ length: 20 }, (_, i) => i),
    {
      headers: {
        "content-length": "20",
        "content-type": "video/mp4",
        etag: '"clip"',
        "content-security-policy": "default-src 'self'",
      },
    },
  );
for (const [range, status, contentRange, expected] of [
  ["bytes=0-1", 206, "bytes 0-1/20", [0, 1]],
  ["bytes=18-", 206, "bytes 18-19/20", [18, 19]],
  ["bytes=-3", 206, "bytes 17-19/20", [17, 18, 19]],
  ["bytes=18-999", 206, "bytes 18-19/20", [18, 19]],
  ["bytes=20-", 416, "bytes */20", []],
  ["bytes=-0", 416, "bytes */20", []],
  ["bytes=9-2", 416, "bytes */20", []],
]) {
  const r = await demoResponse(
    new Request("https://localdot.dev/demos/work.mp4", { headers: { Range: range } }),
    response(),
  );
  assert.equal(r.status, status, range);
  assert.equal(r.headers.get("content-range"), contentRange);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], expected);
  assert.ok(r.headers.has("content-security-policy"));
}
for (const headers of [
  {},
  { Range: "bytes=0-1,4-5" },
  { Range: "bytes=0-1", "If-Range": '"old"' },
  { Range: "bytes=0-1", "If-Range": 'W/"clip"' },
]) {
  const r = await demoResponse(
    new Request("https://localdot.dev/demos/work.mp4", { headers }),
    response(),
  );
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 20);
}
const cached = new Response(null, { status: 304 });
assert.equal(
  await demoResponse(new Request("https://localdot.dev/demos/work.mp4"), cached),
  cached,
);
console.log(
  "Video prefix, suffix, open-ended, clamped, unsatisfiable, validator and conditional response checks passed.",
);

const unframed = new Response(Uint8Array.from([0, 1, 2, 3]));
const partial = await demoResponse(
  new Request("https://localdot.dev/demos/work.mp4", { headers: { range: "bytes=1-2" } }),
  unframed,
);
assert.equal(partial.status, 206);
assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [1, 2]);
console.log("Missing Content-Length binding response passed.");
