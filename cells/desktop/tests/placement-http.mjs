import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Bundle these production exports with esbuild; run this probe in the Linux desktop image.
const {
  placeDownload,
  placementHeader,
  parsePlacementHeader,
  createDesktopdApp,
  serve,
  desktopPlacement,
  QuarantineStore,
  Hono,
  quarantineRoutes,
  quarantineAccess,
  Transfers,
} = await import(pathToFileURL(process.env.LOCALDOT_PLACEMENT_TEST_BUNDLE).href);
const helper = process.env.LOCALDOT_PLACEMENT_TEST_HELPER;
const homes = [];
const token = "t".repeat(43);
const id = () => `0${randomUUID().replaceAll("-", "").slice(0, 25).toUpperCase()}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture(bytes = Buffer.from("approved bytes\0\xff"), options = {}) {
  const home = await mkdtemp(join(tmpdir(), "localdot-placement-http-"));
  homes.push(home);
  const command = {
    transferId: id(),
    parentCellId: id(),
    name: "报告.txt",
    bytes: bytes.length,
    sha256: sha(bytes),
    reconcileOnly: false,
  };
  const abort = new AbortController();
  const source = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  const settings = { helper, timeoutMs: 3000, ...options };
  const place = (body = source(), request = command) =>
    placeDownload(home, request, body, abort.signal, settings);
  let calls = 0;
  let retired;
  const app = createDesktopdApp({
    token,
    scale: 2,
    display: ":1",
    readXsettings: async () => null,
    readScreen: async () => null,
    tools: {
      home,
      env: {},
      browser: { read: async () => ({}), navigate: async () => ({}) },
      placeDownload: async (...args) => {
        calls++;
        try {
          return await placeDownload(...args, settings);
        } finally {
          retired?.();
        }
      },
    },
  });
  const headers = () => ({
    authorization: `Bearer ${token}`,
    "x-localdot-placement": placementHeader(command),
  });
  return {
    home,
    bytes,
    command,
    abort,
    source,
    settings,
    place,
    app,
    headers,
    calls: () => calls,
    onRetired: (callback) => {
      retired = callback;
    },
  };
}

async function files(f) {
  try {
    return await readdir(join(f.home, "Downloads"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function until(predicate, ms = 2000) {
  const deadline = performance.now() + ms;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, "timed out waiting for fixture state");
    await delay(10);
  }
}

async function fake(f, body) {
  const path = join(f.home, "test-helper.py");
  await writeFile(path, `import sys,json,os,time,signal\n${body}\n`);
  f.settings.helper = path;
  return path;
}

test("production authenticated route streams a file larger than the default JSON bound", async () => {
  const f = await fixture(Buffer.alloc(192 * 1024 + 7, 73));
  const response = await f.app.request("/downloads/place", {
    method: "POST",
    headers: f.headers(),
    body: f.bytes,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = await response.json();
  assert.equal(receipt.path, "~/Downloads/报告.txt");
  assert.deepEqual(await readFile(join(f.home, receipt.path.slice(2))), f.bytes);
  assert.equal(f.calls(), 1);
});

test("route authenticates and validates metadata and size before launching placement", async () => {
  const f = await fixture();
  const denied = await f.app.request("/downloads/place", { method: "POST", body: f.bytes });
  assert.equal(denied.status, 401);
  for (const header of [
    "",
    "bad=",
    "?",
    Buffer.from('{"eval":"x"}').toString("base64url"),
    "x".repeat(4097),
  ]) {
    const response = await f.app.request("/downloads/place", {
      method: "POST",
      headers: { ...f.headers(), "x-localdot-placement": header },
      body: f.bytes,
    });
    assert.equal(response.status, 400);
  }
  const size = await f.app.request("/downloads/place", {
    method: "POST",
    headers: { ...f.headers(), "content-length": "99" },
    body: f.bytes,
  });
  assert.equal(size.status, 400);
  assert.equal(f.calls(), 0);
  assert.deepEqual(await files(f), []);
});

test("header round trip preserves Unicode and rejects unknown authority fields", async () => {
  const f = await fixture();
  assert.deepEqual(parsePlacementHeader(placementHeader(f.command)), f.command);
  const extra = Buffer.from(JSON.stringify({ ...f.command, path: "/etc/passwd" })).toString(
    "base64url",
  );
  assert.throws(() => parsePlacementHeader(extra), /request/);
  assert.throws(() => placementHeader({ ...f.command, bytes: 1024 ** 3 + 1 }));
});

test("zero-byte files are committed without treating missing request body as an error", async () => {
  const f = await fixture(Buffer.alloc(0));
  const receipt = await f.place(null);
  assert.equal((await readFile(join(f.home, receipt.path.slice(2)))).length, 0);
});

test("short and overlong bodies never place a visible file", async () => {
  for (const bytes of [Buffer.from("short"), Buffer.alloc(128)]) {
    const f = await fixture();
    const source = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    await assert.rejects(f.place(source), /request|refused/);
    assert.deepEqual(await files(f), []);
  }
});

test("matching count with altered bytes is rejected by the helper before commit", async () => {
  const f = await fixture();
  const response = await f.app.request("/downloads/place", {
    method: "POST",
    headers: f.headers(),
    body: Buffer.alloc(f.bytes.length, 88),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await files(f), []);
});

test("reconciliation returns the same receipt without recreating a file deleted after delivery", async () => {
  const f = await fixture();
  const receipt = await f.place();
  await rm(join(f.home, receipt.path.slice(2)));
  const result = await f.place(null, { ...f.command, reconcileOnly: true });
  assert.deepEqual(result, receipt);
  assert.deepEqual(await files(f), []);
});

test("an absent reconciliation receipt cannot start fresh delivery", async () => {
  const f = await fixture();
  await assert.rejects(f.place(null, { ...f.command, reconcileOnly: true }), /refused/);
  assert.deepEqual(await files(f), []);
});

test("abort waits for the source cancellation to settle", async () => {
  const f = await fixture(Buffer.alloc(128 * 1024, 1));
  const drain = Promise.withResolvers();
  const cancelling = Promise.withResolvers();
  const source = new ReadableStream({
    start(c) {
      c.enqueue(f.bytes.subarray(0, 64 * 1024));
    },
    cancel() {
      cancelling.resolve();
      return drain.promise;
    },
  });
  const work = f.place(source);
  void work.catch(() => {});
  await until(() =>
    existsSync(join(f.home, ".localdot-downloads", f.command.transferId, "payload")),
  );
  f.abort.abort();
  await cancelling.promise;
  let settled = false;
  void work
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await delay(30);
  assert.equal(settled, false, "must retain physical drain until source cancellation finishes");
  drain.resolve();
  await assert.rejects(work, /aborted/);
  assert.deepEqual(await files(f), []);
  assert.equal(
    existsSync(join(f.home, ".localdot-downloads", f.command.transferId, "payload")),
    false,
  );
});

test("pre-aborted and locked sources do not launch the helper", async () => {
  const f = await fixture();
  f.abort.abort();
  await assert.rejects(f.place(), /aborted/);
  const g = await fixture();
  const source = g.source();
  const lock = source.getReader();
  await assert.rejects(g.place(source));
  lock.releaseLock();
  assert.deepEqual(await readdir(f.home), []);
  assert.deepEqual(await readdir(g.home), []);
});

test("spawn failure returns a bounded failure", async () => {
  const f = await fixture();
  f.settings.python = "/no-such-placement-python";
  await assert.rejects(f.place(), /unavailable/);
});

test("success waits for physical helper exit after its receipt", async () => {
  const f = await fixture(Buffer.alloc(0));
  const marker = join(f.home, "pid");
  await fake(
    f,
    `header=json.loads(sys.stdin.buffer.readline())\nopen(${JSON.stringify(marker)},'w').write(str(os.getpid()))\nprint(json.dumps({'ready':True}),flush=True)\nsys.stdin.buffer.read()\nr=header['request'];r['path']='~/Downloads/'+r['name']\nprint(json.dumps({'receipt':r}),flush=True)\ntime.sleep(0.15)`,
  );
  const receipt = await f.place(null);
  assert.equal(receipt.path, "~/Downloads/报告.txt");
  const pid = (await readFile(marker, "utf8")).trim();
  assert.equal(existsSync(`/proc/${pid}`), false);
});

test("deadline kills a helper that ignores graceful termination and waits for exit", async () => {
  const f = await fixture(Buffer.alloc(0), { timeoutMs: 250, killAfterMs: 60 });
  const marker = join(f.home, "pid");
  await fake(
    f,
    `signal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(marker)},'w').write(str(os.getpid()))\nsys.stdin.buffer.readline()\ntime.sleep(30)`,
  );
  await assert.rejects(f.place(null), /unavailable/);
  const pid = (await readFile(marker, "utf8")).trim();
  assert.equal(existsSync(`/proc/${pid}`), false);
});

test("extra protocol output after a receipt cannot turn into success", async () => {
  const f = await fixture(Buffer.alloc(0));
  await fake(
    f,
    `header=json.loads(sys.stdin.buffer.readline())\nprint(json.dumps({'ready':True}),flush=True)\nsys.stdin.buffer.read()\nr=header['request'];r['path']='~/Downloads/'+r['name']\nsys.stdout.write(json.dumps({'receipt':r})+'\\n'+json.dumps({'extra':True})+'\\n');sys.stdout.flush()`,
  );
  await assert.rejects(f.place(null), /unavailable/);
});

test("actual HTTP disconnect drains the placement child before the route retires", async () => {
  const f = await fixture(Buffer.alloc(256 * 1024, 1));
  const marker = join(f.home, "pid");
  await fake(
    f,
    `import runpy\nopen(${JSON.stringify(marker)},'w').write(str(os.getpid()))\nrunpy.run_path(${JSON.stringify(helper)},run_name='__main__')`,
  );
  const retired = Promise.withResolvers();
  f.onRetired(retired.resolve);
  const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const address = server.address();
  let request;
  try {
    request = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/downloads/place",
      method: "POST",
      headers: { ...f.headers(), "content-length": String(f.bytes.length) },
    });
    request.on("error", () => {});
    request.write(f.bytes.subarray(0, 64 * 1024));
    await until(
      () =>
        existsSync(marker) &&
        existsSync(join(f.home, ".localdot-downloads", f.command.transferId, "payload")),
    );
    const pid = (await readFile(marker, "utf8")).trim();
    assert.equal(existsSync(`/proc/${pid}`), true);
    request.destroy();
    await Promise.race([
      retired.promise,
      delay(2500).then(() => {
        throw new Error("route did not drain after disconnect");
      }),
    ]);
    assert.equal(existsSync(`/proc/${pid}`), false);
    assert.deepEqual(await files(f), []);
  } finally {
    request?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function quarantineFlow(dropFirstReply = false) {
  const f = await fixture();
  const host = await mkdtemp(join(tmpdir(), "localdot-host-quarantine-"));
  homes.push(host);
  const store = await QuarantineStore.open(host);
  const scope = { signal: f.abort.signal, check: () => f.abort.signal.throwIfAborted() };
  const item = await store.ingest(
    {
      parentCellId: f.command.parentCellId,
      browserCellId: id(),
      browserInstance: randomUUID(),
      sessionId: id(),
      name: f.command.name,
      source: "downloads.example.test",
    },
    Readable.from([f.bytes]),
    scope,
  );
  let drop = dropFirstReply;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const response = await f.app.fetch(request);
      if (drop && response.status === 200) {
        drop = false;
        return new Response("reply unavailable", { status: 503 });
      }
      return response;
    },
  });
  await new Promise((resolve) => server.on("listening", resolve));
  const address = server.address();
  const endpoint = { baseUrl: `http://127.0.0.1:${address.port}`, token };
  const place = desktopPlacement(
    (parent) => (parent === f.command.parentCellId ? endpoint : undefined),
    3000,
  );
  const approval = {
    revision: item.revision,
    sha256: item.sha256,
    bytes: item.bytes,
    name: item.name,
    to: "computer",
  };
  const release = (target = place) =>
    store.release(item.parentCellId, item.id, approval, scope, target);
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return { f, host, store, item, scope, place, release, close, endpoint, approval };
}

async function userQuarantineFlow(dropFirstReply = false) {
  const q = await quarantineFlow(dropFirstReply),
    transfers = new Transfers();
  const parent = q.item.parentCellId;
  const cell = {
    id: parent,
    state: "ready",
    scale: 1,
    createdAt: "2026-10-06T00:00:00Z",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  };
  // Exercise the production quarantine route/lease/store and real Linux placement.
  // The full host install-token/origin guard is covered by quarantine-routes.test.ts;
  // this in-process, network-isolated fixture does not mount unrelated imaging routes.
  const app = new Hono();
  quarantineRoutes(app, {
    store: q.store,
    exists: (id) => id === parent,
    place: q.place,
    access: (id, signal) =>
      quarantineAccess(
        {
          available: () => true,
          cell: () => cell,
          endpoint: () => q.endpoint,
          session: () => undefined,
          busy: () => false,
          transfers,
        },
        id,
        signal,
      ),
  });
  return {
    ...q,
    transfers,
    request: (suffix = "", body, auth = token) =>
      app.request(`http://127.0.0.1:4747/api/cells/${parent}/quarantine${suffix}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      transfers.close();
      await transfers.settled();
      await q.close();
    },
  };
}

test("user release route checks approval then delivers through the real Linux HTTP/helper chain", async () => {
  const q = await userQuarantineFlow();
  try {
    const path = `/${q.item.id}/release`;
    const listed = await q.request();
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { items: [q.item] });
    assert.deepEqual(await files(q.f), []);
    assert.equal((await q.request(path, { ...q.approval, sha256: "0".repeat(64) })).status, 409);
    assert.equal(q.f.calls(), 0);
    const reply = await q.request(path, q.approval);
    assert.equal(reply.status, 200);
    const released = await reply.json();
    assert.equal(released.state, "released");
    const saved = join(q.f.home, released.receipt.path.slice(2));
    assert.deepEqual(await readFile(saved), q.f.bytes);
    await rm(saved);
    const replay = await q.request(path, q.approval);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), released);
    assert.equal(q.f.calls(), 1);
    assert.deepEqual(
      await files(q.f),
      [],
      "a replay must not recreate a user-deleted delivered file",
    );
  } finally {
    await q.close();
  }
});

test("user release route reconciles a lost desktop receipt without duplicate placement", async () => {
  const q = await userQuarantineFlow(true);
  try {
    const path = `/${q.item.id}/release`;
    assert.equal((await q.request(path, q.approval)).status, 503);
    const pending = q.store.get(q.item.parentCellId, q.item.id);
    assert.equal(pending.state, "releasing");
    assert.deepEqual(await files(q.f), [q.item.name]);
    const reply = await q.request(path, q.approval);
    assert.equal(reply.status, 200);
    const released = await reply.json();
    assert.equal(released.state, "released");
    assert.equal(released.receipt.transferId, pending.release.transferId);
    assert.deepEqual(await files(q.f), [q.item.name]);
    assert.deepEqual(await readFile(join(q.f.home, released.receipt.path.slice(2))), q.f.bytes);
  } finally {
    await q.close();
  }
});

test("user discard route removes the held copy without touching the desktop", async () => {
  const q = await userQuarantineFlow();
  try {
    const reply = await q.request(`/${q.item.id}/discard`, { revision: q.item.revision });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).state, "discarded");
    assert.equal(q.f.calls(), 0);
    assert.deepEqual(await files(q.f), []);
    assert.deepEqual(await readdir(join(q.host, "quarantine", q.item.id)), ["item.json"]);
  } finally {
    await q.close();
  }
});

test("host quarantine releases exact bytes through the real desktop HTTP route and helper", async () => {
  const q = await quarantineFlow();
  try {
    assert.deepEqual(await files(q.f), []);
    const released = await q.release();
    assert.equal(released.state, "released");
    assert.deepEqual(await readFile(join(q.f.home, released.receipt.path.slice(2))), q.f.bytes);
    assert.deepEqual(await readdir(join(q.host, "quarantine", q.item.id)), ["item.json"]);
    assert.deepEqual(await q.release(), released);
    assert.equal(q.f.calls(), 1, "completed host retry must not send another placement");
  } finally {
    await q.close();
  }
});

test("lost HTTP reply after real placement reconciles the original transfer without duplicate bytes", async () => {
  const q = await quarantineFlow(true);
  try {
    await assert.rejects(q.release(), /refused/);
    const pending = q.store.get(q.item.parentCellId, q.item.id);
    assert.equal(pending.state, "releasing");
    assert.deepEqual(await files(q.f), [q.item.name]);
    const released = await q.release();
    assert.equal(released.state, "released");
    assert.equal(released.receipt.transferId, pending.release.transferId);
    assert.deepEqual(await files(q.f), [q.item.name]);
    assert.deepEqual(await readFile(join(q.f.home, released.receipt.path.slice(2))), q.f.bytes);
    assert.equal(q.f.calls(), 2);
  } finally {
    await q.close();
  }
});

test("the desktop cannot commit before the host completes its final source validation", async () => {
  const q = await quarantineFlow();
  const retired = Promise.withResolvers();
  q.f.onRetired(retired.resolve);
  try {
    const withheld = (request, chunks, scope, options) =>
      q.place(
        request,
        (async function* () {
          for await (const chunk of chunks) yield chunk;
          const record = join(q.f.home, ".localdot-downloads", request.transferId, "record.json");
          await until(async () => {
            try {
              return JSON.parse(await readFile(record, "utf8")).state === "verified";
            } catch {
              return false;
            }
          });
          assert.deepEqual(
            await files(q.f),
            [],
            "received bytes are insufficient until host source EOF is admitted",
          );
          throw new Error("source final validation refused");
        })(),
        scope,
        options,
      );
    await assert.rejects(q.release(withheld), /unavailable/);
    await retired.promise;
    assert.deepEqual(await files(q.f), []);
    const pending = q.store.get(q.item.parentCellId, q.item.id);
    assert.equal(pending.state, "releasing");
    const recovered = await q.release();
    assert.equal(recovered.state, "held");
    assert.equal(recovered.revision, 3);
    assert.equal(recovered.recovery.result.transferId, pending.release.transferId);
    assert.equal(recovered.recovery.result.status, "not-placed");
    const tombstone = join(
      q.f.home,
      ".localdot-downloads",
      pending.release.transferId,
      "record.json",
    );
    assert.equal(JSON.parse(await readFile(tombstone, "utf8")).state, "not-placed");
    await assert.rejects(
      q.release(),
      /stale/,
      "the original approval must not authorize a new attempt",
    );
    assert.deepEqual(await files(q.f), []);
    const newApproval = {
      revision: recovered.revision,
      sha256: recovered.sha256,
      bytes: recovered.bytes,
      name: recovered.name,
      to: "computer",
    };
    const released = await q.store.release(
      recovered.parentCellId,
      recovered.id,
      newApproval,
      q.scope,
      q.place,
    );
    assert.equal(released.state, "released");
    assert.equal(released.revision, 5);
    assert.notEqual(released.receipt.transferId, pending.release.transferId);
    assert.deepEqual(await files(q.f), [q.item.name]);
    assert.deepEqual(await readFile(join(q.f.home, released.receipt.path.slice(2))), q.f.bytes);
  } finally {
    await q.close();
  }
});
