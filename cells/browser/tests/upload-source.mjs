import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

const {
  inspectUploadSource,
  readUploadSource,
  BrowserClient,
  DesktopdTools,
  createDesktopdApp,
  serve,
  UPLOAD_BYTES,
} = await import(process.env.LOCALDOT_UPLOAD_TEST_BUNDLE);
const signal = () => new AbortController().signal;
const scope = (current = signal()) => ({
  signal: current,
  check() {
    current.throwIfAborted();
  },
});
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp("/tmp/desktop-upload-");
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const path = join(home, "报告.txt");
  const bytes = Buffer.from("approved desktop bytes 中文");
  await writeFile(path, bytes, { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, path, bytes };
}
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("approved descriptor-relative source metadata and stream agree, including empty files", async (t) => {
  const f = await fixture(t);
  const info = await inspectUploadSource(f.home, f.path, signal());
  assert.deepEqual(
    { ...info, identity: "opaque" },
    {
      path: "~/报告.txt",
      name: "报告.txt",
      bytes: f.bytes.length,
      sha256: sha(f.bytes),
      identity: "opaque",
    },
  );
  assert.match(info.identity, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await collect(await readUploadSource(f.home, info, signal())), f.bytes);
  await writeFile(f.path, "");
  const empty = await inspectUploadSource(f.home, "报告.txt", signal());
  assert.equal(empty.bytes, 0);
  assert.deepEqual(await collect(await readUploadSource(f.home, empty, signal())), Buffer.alloc(0));
});

for (const path of ["../outside", "~/../outside", "/etc/passwd", "~", "x\u0000y"])
  test(`source path ${JSON.stringify(path)} is refused`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(inspectUploadSource(f.home, path, signal()));
  });

test("final symlinks, directory symlinks, and hardlinks are refused", async (t) => {
  const f = await fixture(t);
  await symlink(f.path, join(f.home, "linked"));
  await symlink(f.home, join(f.home, "nested"));
  for (const path of ["~/linked", "~/nested/报告.txt"])
    await assert.rejects(inspectUploadSource(f.home, path, signal()));
  await link(f.path, join(f.home, "hardlink"));
  await assert.rejects(inspectUploadSource(f.home, "~/报告.txt", signal()));
});

for (const change of ["content", "replacement", "mode", "ancestor"])
  test(`${change} changed after approval refuses before streaming`, async (t) => {
    const f = await fixture(t);
    const info = await inspectUploadSource(f.home, f.path, signal());
    if (change === "content") await writeFile(f.path, "other");
    if (change === "replacement") {
      await rename(f.path, join(f.home, "old"));
      await writeFile(f.path, f.bytes);
    }
    if (change === "mode") await chmod(f.path, 0o644);
    if (change === "ancestor") {
      await rename(f.home, join(f.root, "previous"));
      await mkdir(f.home, { mode: 0o700 });
      await writeFile(f.path, f.bytes, { mode: 0o600 });
    }
    await assert.rejects(readUploadSource(f.home, info, signal()));
  });

test("changing a file after its last data chunk prevents successful EOF", async (t) => {
  const f = await fixture(t);
  const info = await inspectUploadSource(f.home, f.path, signal());
  const reader = (await readUploadSource(f.home, info, signal())).getReader();
  assert.deepEqual((await reader.read()).value, f.bytes);
  await writeFile(f.path, f.bytes); // Same content still has a changed approval identity.
  await assert.rejects(reader.read());
  reader.releaseLock();
});

test("unrelated files do not invalidate the approved ancestor directories", async (t) => {
  const f = await fixture(t);
  const info = await inspectUploadSource(f.home, f.path, signal());
  await writeFile(join(f.home, "unrelated.txt"), "independent");
  assert.deepEqual(await collect(await readUploadSource(f.home, info, signal())), f.bytes);
});

test("oversized source files are refused without reading their contents", async (t) => {
  const f = await fixture(t);
  const fd = await open(f.path, "w");
  await fd.truncate(UPLOAD_BYTES + 1);
  await fd.close();
  await assert.rejects(inspectUploadSource(f.home, f.path, signal()), { status: 413 });
});

test("cancelling before the first pull and aborting a reader close the owned descriptors", async (t) => {
  const f = await fixture(t);
  const info = await inspectUploadSource(f.home, f.path, signal());
  const descriptors = async () => (await readdir("/proc/self/fd")).length;
  const before = await descriptors();
  for (let i = 0; i < 15; i++) await (await readUploadSource(f.home, info, signal())).cancel();
  const abort = new AbortController();
  const reader = (await readUploadSource(f.home, info, abort.signal)).getReader();
  await reader.read();
  abort.abort();
  await assert.rejects(reader.read());
  reader.releaseLock();
  assert.equal(await descriptors(), before);
});

const permit = {
  browserCellId: "01J00000000000000000000011",
  parentCellId: "01J00000000000000000000012",
  instance: "b6adbffb-ad25-4d50-9297-5078b1d2cb4a",
  revision: 1,
  requestId: "01J00000000000000000000013",
  owner: { sessionId: "01J00000000000000000000014", generation: 1 },
};
const tabId = "78a2f22b-686d-43f5-aa33-078a16a368f1",
  chooserId = "88a2f22b-686d-43f5-aa33-078a16a368f1";

async function browserFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new BrowserClient({
    ...permit,
    browserd: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "a".repeat(43) },
  });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return client;
}
const upload = (bytes) => ({
  permit,
  tabId,
  chooserId,
  destination: { origin: "https://example.test", embedded: false },
  files: [{ name: "报告.txt", bytes: bytes.length, sha256: sha(bytes) }],
});
function response(res, raw) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ chooserId: raw.chooserId, destination: raw.destination, files: raw.files }),
  );
}

test("sender checks exact bytes and only commits after source validation and destruction finish", async (t) => {
  const bytes = Buffer.from("approved"),
    raw = upload(bytes);
  const received = Promise.withResolvers(),
    destroy = Promise.withResolvers();
  let ended = false,
    input;
  const client = await browserFixture(t, (req, res) => {
    assert.equal(req.url, "/uploads/send");
    assert.equal(req.headers["content-length"], undefined);
    assert.equal(req.headers["transfer-encoding"], "chunked");
    input = JSON.parse(Buffer.from(req.headers["x-localdot-upload"], "base64url").toString());
    req.on("data", () => received.resolve());
    req.once("end", () => {
      ended = true;
      response(res, raw);
    });
  });
  let sent = false;
  const source = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(bytes);
        this.push(null);
      }
    },
    destroy(error, done) {
      void destroy.promise.then(() => done(error));
    },
  });
  const operation = client.upload(raw, source, scope());
  await received.promise;
  await tick();
  assert.equal(ended, false);
  assert.deepEqual(input, raw);
  destroy.resolve();
  assert.deepEqual(await operation, { chooserId, destination: raw.destination, files: raw.files });
  assert.equal(ended, true);
});

for (const [kind, sourceBytes] of [
  ["truncated", "approv"],
  ["oversized", "approved-extra"],
  ["substituted", "attacker"],
])
  test(`sender refuses ${kind} bytes without sending the final commit`, async (t) => {
    const raw = upload(Buffer.from("approved"));
    let ended = false;
    const client = await browserFixture(t, (req) => {
      req.resume();
      req.on("end", () => {
        ended = true;
      });
    });
    await assert.rejects(client.upload(raw, Readable.from([Buffer.from(sourceBytes)]), scope()));
    assert.equal(ended, false);
  });

test("source validation failure after all bytes were sent aborts instead of committing", async (t) => {
  const raw = upload(Buffer.from("approved"));
  let ended = false;
  const received = Promise.withResolvers();
  const client = await browserFixture(t, (req) => {
    req.on("data", () => received.resolve());
    req.on("end", () => {
      ended = true;
    });
  });
  const source = new Readable({ read() {} });
  const operation = client.upload(raw, source, scope());
  const failed = assert.rejects(operation);
  source.push(Buffer.from("approved"));
  await received.promise;
  source.destroy(new Error("approved source changed"));
  await failed;
  assert.equal(ended, false);
});

test("cancellation owns stalled input and an unresponsive reply until socket/source cleanup", async (t) => {
  const raw = upload(Buffer.from("approved"));
  const client = await browserFixture(t, (req) => req.resume());
  for (const source of [new Readable({ read() {} }), Readable.from([Buffer.from("approved")])]) {
    const abort = new AbortController();
    const pending = client.upload(raw, source, scope(abort.signal));
    const failed = assert.rejects(pending);
    await tick();
    abort.abort();
    await failed;
    assert(source.destroyed);
  }
});

test("early, mismatched, and redirected replies cannot acknowledge an upload", async (t) => {
  const bytes = Buffer.from("approved"),
    raw = upload(bytes);
  for (const kind of ["early", "mismatch", "origin", "embedded", "redirect"]) {
    const client = await browserFixture(t, (req, res) => {
      if (kind === "early") {
        response(res, raw);
        req.resume();
        return;
      }
      req.resume();
      req.on("end", () => {
        if (kind === "redirect") {
          res.writeHead(302, { location: "http://example.invalid" });
          res.end();
        } else if (kind === "origin")
          response(res, {
            ...raw,
            destination: { ...raw.destination, origin: "https://other.test" },
          });
        else if (kind === "embedded")
          response(res, { ...raw, destination: { ...raw.destination, embedded: true } });
        else response(res, { ...raw, chooserId: tabId });
      });
    });
    const source =
      kind === "early"
        ? new Readable({
            read() {
              this.push(bytes);
              this._read = () => {};
            },
          })
        : Readable.from([bytes]);
    await assert.rejects(client.upload(raw, source, scope()));
    assert(source.destroyed);
  }
});

test("authenticated desktop routes return verified metadata and chunked source bytes", async (t) => {
  const f = await fixture(t);
  const app = createDesktopdApp({
    token: "a".repeat(43),
    scale: 1,
    display: ":1",
    readXsettings: async () => null,
    readScreen: async () => null,
    tools: {
      home: f.home,
      env: {},
      browser: {
        read: async () => {
          throw new Error("unused");
        },
        navigate: async () => {
          throw new Error("unused");
        },
      },
    },
  });
  let server;
  await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const send = (path, body, token = "a".repeat(43)) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          method: "POST",
          path,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.once("error", reject);
          res.once("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
  assert.equal((await send("/files/upload-info", { path: f.path }, "wrong")).status, 401);
  const inspected = await send("/files/upload-info", { path: f.path });
  assert.equal(inspected.status, 200);
  const info = JSON.parse(inspected.bytes.toString());
  const result = await send("/files/upload-read", { file: info });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-length"], undefined);
  assert.equal(result.headers["transfer-encoding"], "chunked");
  assert.deepEqual(result.bytes, f.bytes);
  await writeFile(f.path, "changed");
  assert.equal((await send("/files/upload-read", { file: info })).status, 409);
});

test("closing the desktop client drains idle streams, pending headers and inspections", async (t) => {
  const f = await fixture(t);
  const info = await inspectUploadSource(f.home, f.path, signal());
  const connections = [];
  const server = createServer((req) => {
    req.resume();
  });
  server.on("connection", (socket) => connections.push(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const endpoint = { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "a".repeat(43) };
  const tools = new DesktopdTools(endpoint);
  const idle = tools.readUpload(info);
  const active = tools.readUpload(info);
  active.resume();
  const inspect = assert.rejects(tools.inspectUpload(info.path));
  for (let i = 0; i < 100 && connections.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(connections.length, 2);
  await tools.close();
  await inspect;
  assert(idle.destroyed && active.destroyed);
  assert.throws(() => tools.readUpload(info));
});
