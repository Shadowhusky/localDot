import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const {
  BrowserDownloadSpool,
  BrowserDownloadEvents,
  BrowserDownloadService,
  BrowserHttp,
  BrowserControl,
  BrowserClient,
  BrowserDownloadCollector,
  QuarantineStore,
  Transfers,
  SessionScreens,
  AgentSession,
  browserRuntimeConfig,
  DOWNLOAD_BYTES,
} = await import(process.env.LOCALDOT_SPOOL_TEST_BUNDLE);
const scope = () => ({ signal: new AbortController().signal, check() {} });
const refusal = (reason) => ({ message: `Browser download refused: ${reason}` });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp("/tmp/browser-spool-");
  const directory = join(root, "downloads");
  await mkdir(directory, { mode: 0o700 });
  const spool = await BrowserDownloadSpool.open(directory);
  t.after(async () => {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  });
  const guid = randomUUID();
  const path = join(directory, guid);
  const capture = async (bytes = Buffer.from("canary-中文")) => {
    spool.reserve(guid);
    await writeFile(path, bytes, { mode: 0o600 });
    return spool.completed(guid, bytes.length, scope());
  };
  return { root, directory, spool, guid, path, capture };
}

async function collect(iterator) {
  const chunks = [];
  for await (const bytes of iterator) chunks.push(bytes);
  return Buffer.concat(chunks);
}

test("production session wiring collects agent and user downloads across takeover and handback", async (t) => {
  const f = await fixture(t);
  const config = browserRuntimeConfig({
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000011",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000012",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: "1",
  });
  const identity = {
    browserCellId: config.browserCellId,
    parentCellId: config.parentCellId,
    instance: randomUUID(),
  };
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  let ready = true;
  let retired;
  const stop = () => {
    if (retired) return retired;
    const done = Promise.withResolvers();
    retired = done.promise;
    ready = false;
    const owners = Promise.all([control.close(), service.close()]);
    service.writersExited();
    owners.then(done.resolve, done.reject);
    return retired;
  };
  const cancellations = [];
  const service = new BrowserDownloadService({
    config,
    instance: identity.instance,
    control,
    targets: {
      downloadBehavior: async () => {},
      async cancelDownload(guid) {
        cancellations.push(guid);
        setImmediate(() =>
          service.progress({ guid, state: "canceled", receivedBytes: 0, totalBytes: 0 }),
        );
      },
    },
    openSpool: () => BrowserDownloadSpool.open(f.directory),
    fence() {
      void stop();
    },
  });
  const tabId = randomUUID();
  const http = new BrowserHttp({
    config,
    instance: identity.instance,
    control,
    downloads: service,
    targets: { tabs: () => [{ id: tabId, ready: true }] },
    input: {
      async inject() {
        throw new Error("unused");
      },
      async type() {
        throw new Error("unused");
      },
      async timing(permit, tab, _request, signal) {
        const lease = control.admit(permit);
        try {
          signal.throwIfAborted();
          lease.check();
          assert.equal(tab, tabId);
          return { mono: 1 };
        } finally {
          lease.finish();
        }
      },
    },
    observation: {
      async observe() {
        throw new Error("unused");
      },
    },
    ready: () => ready,
    stop,
    retirement: () => retired,
    fence() {
      void stop();
    },
  });
  await new Promise((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = {
    ...identity,
    browserd: {
      baseUrl: `http://127.0.0.1:${http.server.address().port}`,
      token: config.serviceToken,
    },
    stream: { baseUrl: "http://127.0.0.1:4888", authorization: "fixture" },
  };
  const cell = {
    id: config.parentCellId,
    state: "ready",
    scale: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  };
  const transfers = new Transfers();
  const store = await QuarantineStore.open(f.root);
  const collector = new BrowserDownloadCollector({ store, transfers });
  const journal = [];
  const session = new AgentSession(
    "01J00000000000000000000013",
    cell.id,
    "session download fixture",
    {
      append(_id, event) {
        journal.push(event);
      },
    },
  );
  const screens = new SessionScreens({
    cells: { get: () => cell, subscribe: () => () => {}, stop },
    browser: { start: async () => endpoint, endpoints: () => endpoint, stop },
    streams: {},
    registry: { for: () => undefined },
    recordings: { attach: async () => {}, fence: async () => {} },
    downloads: collector,
    now: () => 0,
  });
  const until = async (check) => {
    for (let i = 0; i < 800 && !(await check()); i++) await sleep(5);
    assert(await check(), "session lifecycle did not reach the expected state");
  };
  const complete = async (label) => {
    const guid = randomUUID(),
      data = Buffer.from(label);
    service.begin({
      guid,
      frameId: "fixture-frame",
      url: "https://files.example.test/report?private=canary",
      suggestedFilename: "report.txt",
    });
    await writeFile(join(f.directory, guid), data, { mode: 0o600 });
    service.progress({
      guid,
      state: "completed",
      receivedBytes: data.length,
      totalBytes: data.length,
    });
    await until(() => store.list(cell.id).some((item) => item.browserDownloadGuid === guid));
    await until(async () => (await readdir(f.directory)).length === 0);
    const item = store.list(cell.id).find((item) => item.browserDownloadGuid === guid);
    assert.equal(item.sessionId, session.id);
    assert.equal(item.state, "held");
    assert.equal(item.source, "files.example.test");
    assert.deepEqual(await readFile(join(f.root, "quarantine", item.id, "payload")), data);
    return item;
  };
  try {
    screens.install(session, cell);
    const generation = session.beginBrain();
    await session.prepareScreens(generation);
    const switching = session.admit(generation);
    await session.switchScreen("browser", switching);
    switching.finish();
    await t.test("agent collection survives completion of the switching tool call", async () => {
      await complete("agent download 中文");
    });
    const takeover = session.takeover("fixture", "user download");
    void takeover.catch(() => {});
    await until(() => session.manualControl === "ready");
    await t.test("current user grant collects with the explicit session identity", async () => {
      await complete("manual download");
    });
    assert.equal(await session.handback(session.pendingTakeover, undefined), true);
    await takeover;
    await t.test("handback drains manual collection and arms the fresh agent grant", async () => {
      await complete("resumed agent download");
    });
    const desktop = session.admit(generation);
    await session.switchScreen("desktop", desktop);
    desktop.finish();
    await t.test("inactive browser downloads are refused after the desktop switch", async () => {
      const guid = randomUUID();
      service.begin({
        guid,
        frameId: "fixture-frame",
        url: "https://files.example.test/background",
        suggestedFilename: "background.txt",
      });
      await until(() => cancellations.includes(guid));
      assert.equal(store.list(cell.id).length, 3);
    });
    session.stop();
    await session.screensSettled();
    await transfers.settled();
    assert(
      journal.some((event) => event.type === "screen.switch" && event.data.screen === "browser"),
    );
    assert.equal(JSON.stringify(journal).includes("private=canary"), false);
  } finally {
    session.stop();
    await session.screensSettled().catch(() => {});
    transfers.close();
    await transfers.settled();
    await http.close();
  }
});

test("completed GUID returns bounded metadata and exact bytes, including repeat read before acknowledgement", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(220_003, 53);
  const file = await f.capture(bytes);
  assert.deepEqual(file, { guid: f.guid, bytes: bytes.length, sha256: hash(bytes) });
  assert(Object.isFrozen(file));
  for (let attempt = 0; attempt < 2; attempt++) {
    const chunks = [];
    for await (const chunk of f.spool.read(file, scope())) {
      assert(chunk.length <= 65536);
      chunks.push(chunk);
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
  }
  await f.spool.remove(f.guid);
  assert.deepEqual(await readdir(f.directory), []);
});

test("empty download has a verified empty digest and stream", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.alloc(0));
  assert.equal(file.sha256, hash(Buffer.alloc(0)));
  assert.equal((await collect(f.spool.read(file, scope()))).length, 0);
});

test("the production download mount supports the full 1GiB file cap outside the smaller runtime tmpfs", async () => {
  const filesystem = await statfs("/downloads");
  assert.equal(filesystem.bsize * filesystem.blocks, 1152 * 1024 * 1024);
  const spool = await BrowserDownloadSpool.open();
  const guid = randomUUID();
  let reader;
  try {
    spool.reserve(guid);
    const file = await open(`/downloads/${guid}`, "wx", 0o600);
    await file.truncate(DOWNLOAD_BYTES);
    await file.close();
    const completed = await spool.completed(guid, DOWNLOAD_BYTES, scope());
    assert.equal(completed.bytes, DOWNLOAD_BYTES);
    reader = spool.read(completed, scope());
    assert.deepEqual((await reader.next()).value, Buffer.alloc(65536));
    await reader.return();
    await spool.remove(guid);
  } finally {
    await reader?.return();
    await spool.close();
    await rm(`/downloads/${guid}`, { force: true });
  }
});

test("reservation remains bounded until terminal bytes are acknowledged", async (t) => {
  const f = await fixture(t);
  f.spool.reserve(f.guid);
  assert.throws(() => f.spool.reserve(randomUUID()), refusal("busy"));
  assert.throws(() => f.spool.reserve(f.guid), refusal("busy"));
  await writeFile(f.path, "abc", { mode: 0o600 });
  await f.spool.completed(f.guid, 3, scope());
  assert.throws(() => f.spool.reserve(randomUUID()), refusal("busy"));
  await f.spool.remove(f.guid);
  f.spool.reserve(randomUUID());
});

test("unowned/path-like identifiers cannot capture, cancel or delete bytes", async (t) => {
  const f = await fixture(t);
  for (const guid of [
    "../outside",
    "/profile/Cookies",
    "a/b",
    f.guid.toUpperCase(),
    `${f.guid}.crdownload`,
    "",
  ]) {
    assert.throws(() => f.spool.reserve(guid), refusal("identity"));
    await assert.rejects(f.spool.completed(guid, 0, scope()), refusal("identity"));
    await assert.rejects(f.spool.remove(guid), refusal("identity"));
  }
  assert.throws(() => f.spool.cancelled(randomUUID()), refusal("identity"));
  assert.deepEqual(await readdir(f.directory), []);
});

test("no reading or deletion before Chromium's terminal event", async (t) => {
  const f = await fixture(t);
  f.spool.reserve(f.guid);
  await writeFile(`${f.path}.crdownload`, "in progress", { mode: 0o600 });
  await assert.rejects(f.spool.remove(f.guid), refusal("busy"));
  await assert.rejects(
    collect(f.spool.read({ guid: f.guid, bytes: 11, sha256: hash("in progress") }, scope())),
    refusal("identity"),
  );
  f.spool.cancelled(f.guid);
  await f.spool.remove(f.guid);
  assert.deepEqual(await readdir(f.directory), []);
});

test("missing final GUID never falls back to partial or reported external path", async (t) => {
  const f = await fixture(t);
  f.spool.reserve(f.guid);
  await writeFile(`${f.path}.crdownload`, "partial", { mode: 0o600 });
  await assert.rejects(f.spool.completed(f.guid, 7, scope()), refusal("identity"));
  await f.spool.remove(f.guid);
});

for (const kind of ["symlink", "hardlink", "fifo", "directory"]) {
  test(`refuses ${kind} without following or blocking on its contents`, async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside");
    await writeFile(outside, "private", { mode: 0o600 });
    f.spool.reserve(f.guid);
    if (kind === "symlink") await symlink(outside, f.path);
    else if (kind === "hardlink") await link(outside, f.path);
    else if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [f.path]);
    else await mkdir(f.path);
    await assert.rejects(f.spool.completed(f.guid, 7, scope()), refusal("identity"));
    assert.equal(await readFile(outside, "utf8"), "private");
  });
}

test("reported byte count and file size must agree; oversized reported transfer is never hashed", async (t) => {
  const f = await fixture(t);
  f.spool.reserve(f.guid);
  await writeFile(f.path, "abc", { mode: 0o600 });
  await assert.rejects(f.spool.completed(f.guid, 2, scope()), refusal("identity"));
  await f.spool.remove(f.guid);
  f.spool.reserve(f.guid);
  await assert.rejects(f.spool.completed(f.guid, DOWNLOAD_BYTES + 1, scope()), refusal("bytes"));
});

for (const mode of [0o620, 0o602, 0o700, 0o4600]) {
  test(`refuses writable/executable/special file permissions ${mode.toString(8)}`, async (t) => {
    const f = await fixture(t);
    f.spool.reserve(f.guid);
    await writeFile(f.path, "abc", { mode: 0o600 });
    await chmod(f.path, mode);
    await assert.rejects(f.spool.completed(f.guid, 3, scope()), refusal("identity"));
  });
}

test("copied/edited metadata is not a capability to read any file", async (t) => {
  const f = await fixture(t);
  const file = await f.capture();
  await assert.rejects(collect(f.spool.read({ ...file }, scope())), refusal("identity"));
});

test("same-byte replacement after completion is refused by inode identity", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.from("abc"));
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, "abc", { mode: 0o600 });
  await assert.rejects(collect(f.spool.read(file, scope())), refusal("identity"));
});

test("modification during stream cannot produce a successful EOF", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.alloc(140000, 49));
  const reader = f.spool.read(file, scope());
  assert.equal((await reader.next()).value.length, 65536);
  const writer = await open(f.path, "r+");
  await writer.write(Buffer.from("changed"), 0, 7, 90000);
  await writer.close();
  await assert.rejects(collect(reader), refusal("identity"));
});

test("the final authority check happens after the last yielded bytes", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.from("abc"));
  let current = true;
  const reader = f.spool.read(file, {
    ...scope(),
    check() {
      if (!current) throw new Error("stale");
    },
  });
  assert.equal((await reader.next()).value.toString(), "abc");
  current = false;
  await assert.rejects(reader.next(), refusal("identity"));
});

test("acknowledgement cancels and waits for a reader to physically return", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.from("abc"));
  const reader = f.spool.read(file, scope());
  await reader.next();
  let removed = false;
  const removal = f.spool.remove(f.guid).then(() => {
    removed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removed, false);
  assert.equal(await readFile(f.path, "utf8"), "abc");
  await reader.return();
  await removal;
  assert.deepEqual(await readdir(f.directory), []);
});

test("close waits for an active reader and keeps a Chromium writer's partial file", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.from("abc"));
  const reader = f.spool.read(file, scope());
  await reader.next();
  let closed = false;
  const closing = f.spool.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  await reader.return();
  await closing;
  assert.equal(await readFile(f.path, "utf8"), "abc");
  assert.throws(() => f.spool.reserve(randomUUID()), refusal("closed"));
});

test("directory replacement cannot redirect reads or deletion into another directory", async (t) => {
  const f = await fixture(t);
  const file = await f.capture(Buffer.from("abc"));
  await rename(f.directory, `${f.directory}.old`);
  await mkdir(f.directory, { mode: 0o700 });
  await writeFile(f.path, "victim", { mode: 0o600 });
  await assert.rejects(collect(f.spool.read(file, scope())), refusal("identity"));
  await assert.rejects(f.spool.remove(f.guid), refusal("identity"));
  assert.equal(await readFile(f.path, "utf8"), "victim");
});

test("rejects symlink or non-private root without opening payload files", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.directory, alias);
  await assert.rejects(BrowserDownloadSpool.open(alias), refusal("identity"));
  await chmod(f.directory, 0o755);
  await assert.rejects(BrowserDownloadSpool.open(f.directory), refusal("identity"));
});

async function eventFixture(t) {
  const f = await fixture(t);
  const abort = new AbortController();
  const cancelled = [];
  const finished = [];
  let count = 0;
  const events = new BrowserDownloadEvents({
    spool: f.spool,
    admit() {
      const id = ++count;
      return {
        origin: {
          parentCellId: "01J00000000000000000000002",
          browserCellId: "01J00000000000000000000001",
          sessionId: "01J00000000000000000000003",
          browserInstance: "b6adbffb-ad25-4d50-9297-5078b1d2cb4a",
        },
        signal: abort.signal,
        check() {
          abort.signal.throwIfAborted();
        },
        finish() {
          finished.push(id);
        },
      };
    },
    async cancel(guid) {
      cancelled.push(guid);
    },
    fence() {
      events.writersExited();
    },
  });
  // The outer fixture closes the spool after these operations; retiring is explicit in each test.
  const begin = (guid = f.guid) =>
    events.begin({
      guid,
      frameId: "frame-1",
      url: "https://files.example.test/private?token=secret",
      suggestedFilename: "report.bin",
    });
  const progress = (guid, state, receivedBytes) =>
    events.progress({
      guid,
      state,
      receivedBytes,
      totalBytes: receivedBytes,
      filePath: "/profile/must-not-be-used",
    });
  const wait = async (predicate) => {
    const end = performance.now() + 2000;
    while (!predicate()) {
      assert(performance.now() < end, "download owner did not settle");
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { ...f, events, begin, progress, wait, abort, cancelled, finished };
}

test("CDP owner and actual spool deliver only a completed GUID, then retire after bound acknowledgement", async (t) => {
  const f = await eventFixture(t);
  try {
    f.begin();
    const bytes = Buffer.from("native spool integration 中文");
    await writeFile(f.path, bytes, { mode: 0o600 });
    assert.deepEqual(f.events.list(), []);
    f.progress(f.guid, "completed", bytes.length);
    await f.wait(() => f.events.list().length === 1);
    const [offer] = f.events.list();
    assert.equal(offer.sha256, hash(bytes));
    assert.equal(offer.origin.source, "files.example.test");
    assert(!JSON.stringify(offer).match(/secret|private|profile/));
    assert.deepEqual(await collect(f.events.read(f.guid, scope())), bytes);
    assert.deepEqual(f.finished, []);
    await f.events.acknowledge(f.guid, offer, scope());
    assert.deepEqual(f.finished, [1]);
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    f.events.writersExited();
    await f.events.close();
  }
});

test("actual partial file and action lease survive cancel reply until terminal progress", async (t) => {
  const f = await eventFixture(t);
  try {
    f.begin();
    await writeFile(`${f.path}.crdownload`, "partial", { mode: 0o600 });
    f.abort.abort();
    await f.wait(() => f.cancelled.length === 1);
    assert.deepEqual(f.finished, []);
    assert.equal(await readFile(`${f.path}.crdownload`, "utf8"), "partial");
    f.progress(f.guid, "canceled", 7);
    await f.wait(() => f.finished.length === 1);
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    f.events.writersExited();
    await f.events.close();
  }
});

test("concurrent refused GUID cleanup cannot remove an admitted ready download", async (t) => {
  const f = await eventFixture(t);
  try {
    f.begin();
    await writeFile(f.path, "abc", { mode: 0o600 });
    f.progress(f.guid, "completed", 3);
    await f.wait(() => f.events.list().length === 1);
    const rejected = randomUUID();
    f.begin(rejected);
    await writeFile(join(f.directory, rejected), "refused", { mode: 0o600 });
    await f.wait(() => f.cancelled.includes(rejected));
    f.progress(rejected, "completed", 7);
    await f.wait(() => f.finished.includes(2));
    assert.deepEqual(await readdir(f.directory), [f.guid]);
    assert.equal(f.events.list()[0].guid, f.guid);
    assert.equal((await collect(f.events.read(f.guid, scope()))).toString(), "abc");
  } finally {
    f.events.writersExited();
    await f.events.close();
  }
});

test("production authenticated download service streams a real Linux spool and acknowledges only its bound digest", async (t) => {
  const f = await fixture(t);
  const config = browserRuntimeConfig({
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: "1",
  });
  const instance = randomUUID();
  const identity = {
    browserCellId: config.browserCellId,
    parentCellId: config.parentCellId,
    instance,
  };
  const permit = { ...identity, requestId: "01J00000000000000000000004", revision: 1 };
  const binding = { holder: "user", sessionId: "01J00000000000000000000003", permit };
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "user" });
  let ready = true;
  let retired;
  const behaviors = [];
  const stop = () => {
    if (retired) return retired;
    const done = Promise.withResolvers();
    retired = done.promise;
    ready = false;
    const owners = Promise.all([control.close(), service.close()]);
    service.writersExited();
    owners.then(done.resolve, done.reject);
    return retired;
  };
  const service = new BrowserDownloadService({
    config,
    instance,
    control,
    targets: {
      async downloadBehavior(enabled) {
        behaviors.push(enabled);
      },
      async cancelDownload() {},
    },
    openSpool: async () => f.spool,
    fence() {
      void stop();
    },
  });
  const http = new BrowserHttp({
    config,
    instance,
    control,
    downloads: service,
    targets: { tabs: () => [] },
    input: {
      async inject() {
        throw new Error("unused");
      },
      async type() {
        throw new Error("unused");
      },
    },
    observation: {
      async observe() {
        throw new Error("unused");
      },
    },
    ready: () => ready,
    stop,
    retirement: () => retired,
    fence() {
      void stop();
    },
  });
  await new Promise((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", resolve);
  });
  const port = http.server.address().port;
  const post = (path, body, token = config.serviceToken) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path,
          agent: false,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (bytes) => chunks.push(bytes));
          res.once("error", reject);
          res.once("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    assert.equal((await post("/downloads/arm", { binding }, "wrong")).status, 401);
    assert.deepEqual(behaviors, []);
    assert.equal((await post("/downloads/arm", { binding })).status, 200);
    assert.deepEqual(behaviors, [false, true]);
    service.begin({
      guid: f.guid,
      frameId: "frame-1",
      url: "https://files.example.test/data?secret=canary",
      suggestedFilename: "report.bin",
    });
    const data = Buffer.alloc(220005, 71);
    await writeFile(f.path, data, { mode: 0o600 });
    assert.deepEqual(JSON.parse((await post("/downloads/list", { binding })).bytes).downloads, []);
    service.progress({
      guid: f.guid,
      state: "completed",
      receivedBytes: data.length,
      totalBytes: data.length,
      filePath: "/profile/private",
    });
    let offer;
    for (let attempt = 0; attempt < 50 && !offer; attempt++) {
      offer = JSON.parse((await post("/downloads/list", { binding })).bytes).downloads[0];
    }
    assert(offer, "completed download did not become available");
    assert.equal(offer.sha256, hash(data));
    const read = await post("/downloads/read", { binding, guid: f.guid });
    assert.equal(read.status, 200);
    assert.equal(read.headers["content-length"], undefined);
    assert.equal(read.headers["transfer-encoding"], "chunked");
    assert.deepEqual(read.bytes, data);
    assert.equal(
      (
        await post("/downloads/ack", {
          binding,
          guid: f.guid,
          bytes: data.length,
          sha256: "0".repeat(64),
        })
      ).status,
      409,
    );
    assert.deepEqual(await readdir(f.directory), [f.guid]);
    assert.equal(
      (
        await post("/downloads/ack", {
          binding,
          guid: f.guid,
          bytes: data.length,
          sha256: hash(data),
        })
      ).status,
      200,
    );
    assert.deepEqual(await readdir(f.directory), []);
    const store = await QuarantineStore.open(f.root);
    const transfers = new Transfers();
    const collector = new BrowserDownloadCollector({ store, transfers });
    const client = new BrowserClient({
      ...identity,
      browserd: { baseUrl: `http://127.0.0.1:${port}`, token: config.serviceToken },
      stream: { baseUrl: "http://127.0.0.1:4888", authorization: "fixture" },
    });
    try {
      await client.armDownloads(binding, scope());
      for (const data of [
        Buffer.alloc(0),
        Buffer.from("production HTTP to host quarantine 中文"),
      ]) {
        await t.test(
          `production daemon collector ingests ${data.length} bytes before browser removal`,
          async () => {
            const guid = randomUUID();
            service.begin({
              guid,
              frameId: "frame-1",
              url: "https://files.example.test/download",
              suggestedFilename: "verified.txt",
            });
            await writeFile(join(f.directory, guid), data, { mode: 0o600 });
            service.progress({
              guid,
              state: "completed",
              receivedBytes: data.length,
              totalBytes: data.length,
            });
            let ready = false;
            for (let attempt = 0; attempt < 50 && !ready; attempt++)
              ready = (await client.downloads(binding, scope())).length === 1;
            assert(ready, "completed download did not become available");
            const [item] = await collector.collect(client, binding, scope());
            assert.equal(item.state, "held");
            assert.equal(item.browserDownloadGuid, guid);
            assert.equal(item.sha256, hash(data));
            assert.deepEqual(await readFile(join(f.root, "quarantine", item.id, "payload")), data);
            assert.deepEqual(await readdir(f.directory), []);
            assert.deepEqual(await client.downloads(binding, scope()), []);
            await transfers.wait(config.parentCellId);
          },
        );
      }
      assert.equal(store.list(config.parentCellId).length, 2);
    } finally {
      client.close();
      transfers.close();
      await transfers.settled();
    }
    assert.equal((await post("/stop", identity)).status, 200);
  } finally {
    await http.close();
  }
});
