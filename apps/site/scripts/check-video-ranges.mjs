import assert from "node:assert/strict";
import { videoResponse, worker } from "../src/worker.ts";

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
  const r = await videoResponse(
    new Request("https://localdot.dev/demos/breakout/theatre.mp4", { headers: { Range: range } }),
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
  const r = await videoResponse(
    new Request("https://localdot.dev/demos/breakout/theatre.mp4", { headers }),
    response(),
  );
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 20);
}
const cached = new Response(null, { status: 304 });
assert.equal(
  await videoResponse(new Request("https://localdot.dev/demos/breakout/theatre.mp4"), cached),
  cached,
);
console.log(
  "Video prefix, suffix, open-ended, clamped, unsatisfiable, validator and conditional response checks passed.",
);

const unframed = new Response(Uint8Array.from([0, 1, 2, 3]));
const partial = await videoResponse(
  new Request("https://localdot.dev/demos/breakout/theatre.mp4", {
    headers: { range: "bytes=1-2" },
  }),
  unframed,
);
assert.equal(partial.status, 206);
assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [1, 2]);
console.log("Missing Content-Length binding response passed.");

// The film is larger than any clip read into memory: its ranges come straight from the stream.
const big = 9 * 1024 * 1024;
const film = () =>
  new Response(
    Uint8Array.from({ length: big }, (_, i) => i % 251),
    { headers: { "content-length": String(big), "content-type": "video/mp4" } },
  );
for (const [range, expected] of [
  ["bytes=0-1", [0, 1]],
  [`bytes=${big - 2}-`, [(big - 2) % 251, (big - 1) % 251]],
  ["bytes=-2", [(big - 2) % 251, (big - 1) % 251]],
  ["bytes=5000000-5000002", [5000000 % 251, 5000001 % 251, 5000002 % 251]],
]) {
  const r = await worker.fetch(
    new Request("https://localdot.dev/film/localdot-film.mp4", { headers: { Range: range } }),
    { ASSETS: { fetch: async () => film() } },
  );
  assert.equal(r.status, 206, range);
  assert.equal(r.headers.get("content-length"), String(expected.length), range);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], expected, range);
}
// Every cut of the film, in each language and size, streams the same way.
for (const cut of ["localdot-film-720", "localdot-film-zh", "localdot-film-zh-720"]) {
  const r = await worker.fetch(
    new Request(`https://localdot.dev/film/${cut}.mp4`, {
      headers: { Range: "bytes=5000000-5000001" },
    }),
    { ASSETS: { fetch: async () => film() } },
  );
  assert.equal(r.status, 206, cut);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [5000000 % 251, 5000001 % 251], cut);
}
const outside = await worker.fetch(
  new Request("https://localdot.dev/film/localdot-film.mp4", {
    headers: { Range: `bytes=${big}-` },
  }),
  { ASSETS: { fetch: async () => film() } },
);
assert.equal(outside.status, 416);
const other = await worker.fetch(
  new Request("https://localdot.dev/film/other.mp4", { headers: { Range: "bytes=0-1" } }),
  { ASSETS: { fetch: async () => film() } },
);
assert.equal(other.status, 200);
console.log("Film ranges streamed without buffering passed.");

// A binding that streams a large file without its length: the build's manifest of the site's video
// lengths gives it, and the range still streams.
const stream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from({ length: big }, (_, i) => i % 251));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
const manifested = {
  fetch: async (request) =>
    new URL(request.url ?? request).pathname === "/media-lengths.json"
      ? Response.json({ "/film/localdot-film-zh.mp4": big })
      : stream(),
};
const streamed = await worker.fetch(
  new Request("https://localdot.dev/film/localdot-film-zh.mp4", {
    headers: { Range: "bytes=5000000-5000001" },
  }),
  { ASSETS: manifested },
);
assert.equal(streamed.status, 206);
assert.equal(streamed.headers.get("content-range"), `bytes 5000000-5000001/${big}`);
assert.deepEqual([...new Uint8Array(await streamed.arrayBuffer())], [5000000 % 251, 5000001 % 251]);
console.log("Lengths from the build's manifest passed.");

// With no length from the binding or the build, a large file still plays: whole, as a 200.
const unknown = await worker.fetch(
  new Request("https://localdot.dev/film/localdot-film.mp4", {
    headers: { Range: "bytes=0-" },
  }),
  {
    ASSETS: {
      fetch: async (request) =>
        new URL(request.url ?? request).pathname === "/media-lengths.json"
          ? Response.json({})
          : stream(),
    },
  },
);
assert.equal(unknown.status, 200);
assert.equal((await unknown.arrayBuffer()).byteLength, big);
console.log("A large file of unknown length passed whole.");
