import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

const {
  BrowserUploadStaging,
  BrowserUploadService,
  BrowserTargets,
  BrowserControl,
  BrowserHttp,
  BrowserClient,
  DesktopdTools,
  desktopUploadStream,
  createDesktopdApp,
  serve,
  browserRuntimeConfig,
  UPLOAD_BYTES,
} = await import(process.env.LOCALDOT_UPLOAD_TEST_BUNDLE);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const metadata = (data, name = "报告-report.txt") => ({
  name,
  bytes: data.length,
  sha256: hash(data),
});
const scope = (signal = new AbortController().signal) => ({
  signal,
  check() {
    signal.throwIfAborted();
  },
});
const refused = (reason) => ({ message: `Browser upload staging refused: ${reason}` });

async function fixture(t) {
  const root = await mkdtemp("/tmp/browser-upload-");
  const directory = join(root, "uploads");
  await mkdir(directory, { mode: 0o700 });
  const store = await BrowserUploadStaging.open(directory);
  const f = {
    root,
    directory,
    store,
    retirementFailure: false,
    async paths() {
      return Promise.all(
        (await readdir(directory)).map(async (id) =>
          join(directory, id, (await readdir(join(directory, id)))[0]),
        ),
      );
    },
    async stage(data = Buffer.from("uploaded-中文-canary"), name) {
      return store.stage([metadata(data, name)], Readable.from([data]), scope());
    },
  };
  t.after(async () => {
    store.readersExited();
    try {
      await store.close();
    } catch (error) {
      if (!f.retirementFailure) throw error;
    }
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

test("private immutable files preserve source names and survive assignment until reader retirement", async (t) => {
  const f = await fixture(t);
  const data = Buffer.from("English 中文\u0000 bytes");
  const handle = await f.stage(data);
  assert.deepEqual(handle.files, [metadata(data)]);
  assert(
    Object.isFrozen(handle) && Object.isFrozen(handle.files) && Object.isFrozen(handle.files[0]),
  );
  let assigned;
  await f.store.assign(handle, scope(), async (paths, owner) => {
    assigned = paths;
    assert(Object.isFrozen(paths));
    owner.check();
    assert.equal(basename(paths[0]), "报告-report.txt");
    assert.deepEqual(await readFile(paths[0]), data);
    assert.equal((await lstat(paths[0])).mode & 0o777, 0o400);
  });
  assert.deepEqual(await readFile(assigned[0]), data);
  await assert.rejects(f.store.discard(handle), refused("stale"));
  await assert.rejects(
    f.store.assign(handle, scope(), async () => assert.fail("replay")),
    refused("stale"),
  );
  let retired = false;
  const close = f.store.close().then(() => {
    retired = true;
  });
  await tick();
  assert.equal(retired, false);
  assert.deepEqual(await readFile(assigned[0]), data);
  f.store.readersExited();
  await close;
  assert.deepEqual(await readdir(f.directory), []);
});

test("one byte stream spans empty and duplicate-named files without mixing their contents", async (t) => {
  const f = await fixture(t);
  const data = [Buffer.alloc(0), Buffer.from("alpha"), Buffer.from("beta 中文"), Buffer.alloc(0)];
  const combined = Buffer.concat(data);
  const handle = await f.store.stage(
    data.map((part) => metadata(part, "same.txt")),
    Readable.from([combined.subarray(0, 2), combined.subarray(2)]),
    scope(),
  );
  await f.store.assign(handle, scope(), async (paths) => {
    assert.equal(new Set(paths).size, 4);
    for (let i = 0; i < data.length; i++) assert.deepEqual(await readFile(paths[i]), data[i]);
  });
});

for (const [label, actual, expected] of [
  ["truncation", Buffer.from("short"), metadata(Buffer.from("longer"))],
  ["overflow", Buffer.from("longer"), metadata(Buffer.from("short"))],
  ["digest mismatch", Buffer.from("a"), metadata(Buffer.from("b"))],
])
  test(`${label} removes all unassigned bytes`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.store.stage([expected], Readable.from([actual]), scope()),
      refused("bytes"),
    );
    assert.deepEqual(await readdir(f.directory), []);
    const next = await f.stage();
    await f.store.discard(next);
    assert.deepEqual(await readdir(f.directory), []);
  });

for (const name of [
  "../outside",
  "/absolute",
  "bad\\path",
  "CON",
  "bad\u0000name",
  "x".repeat(181),
])
  test(`unsafe filename ${JSON.stringify(name)} refuses without reading`, async (t) => {
    const f = await fixture(t);
    let reads = 0;
    const input = new Readable({
      read() {
        reads++;
        this.push(null);
      },
    });
    await assert.rejects(
      f.store.stage([metadata(Buffer.alloc(0), name)], input, scope()),
      refused("request"),
    );
    assert.equal(reads, 0);
    assert(input.destroyed);
    assert.deepEqual(await readdir(f.directory), []);
  });

test("zero-byte and total-byte quotas reserve before reading, then free on failed receive", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const large = { name: "large.bin", bytes: UPLOAD_BYTES, sha256: "a".repeat(64) };
  const pending = [0, 1].map(() =>
    f.store.stage([large], new Readable({ read() {} }), scope(abort.signal)),
  );
  for (const task of pending) void task.catch(() => {});
  let reads = 0;
  await assert.rejects(
    f.store.stage(
      [metadata(Buffer.from("1"))],
      new Readable({
        read() {
          reads++;
        },
      }),
      scope(),
    ),
    refused("capacity"),
  );
  assert.equal(reads, 0);
  abort.abort();
  await Promise.all(pending.map((task) => assert.rejects(task)));
  assert.deepEqual(await readdir(f.directory), []);
  const handles = [];
  for (let i = 0; i < 64; i++) handles.push(await f.stage(Buffer.alloc(0)));
  await assert.rejects(f.stage(Buffer.alloc(0)), refused("capacity"));
  await f.store.discard(handles[0]);
  await f.stage(Buffer.alloc(0));
});

test("source destruction is physically drained before the staging operation settles", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const destroying = Promise.withResolvers();
  const release = Promise.withResolvers();
  const source = new Readable({
    read() {},
    destroy(error, callback) {
      destroying.resolve();
      void release.promise.then(() => callback(error));
    },
  });
  let settled = false;
  const task = f.store
    .stage([metadata(Buffer.from("x"))], source, scope(abort.signal))
    .finally(() => {
      settled = true;
    });
  const failed = assert.rejects(task);
  abort.abort();
  await destroying.promise;
  await tick();
  assert.equal(settled, false);
  release.resolve();
  await failed;
  assert.deepEqual(await readdir(f.directory), []);
});

test("scope invalidation before assignment never reaches the native effect", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.store.assign(handle, scope(abort.signal), async () => assert.fail("stale effect")),
  );
  await f.store.discard(handle);
});

test("forged handles and concurrent fills cannot assign a second file list", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage();
  await assert.rejects(
    f.store.assign({ ...handle }, scope(), async () => assert.fail("forged effect")),
    refused("stale"),
  );
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const first = f.store.assign(handle, scope(), async () => {
    entered.resolve();
    await release.promise;
  });
  await assert.rejects(
    f.store.assign(handle, scope(), async () => assert.fail("concurrent effect")),
    refused("stale"),
  );
  await entered.promise;
  await assert.rejects(f.store.discard(handle), refused("stale"));
  release.resolve();
  await first;
});

test("an ambiguous native reply keeps the assigned bytes and refuses replay", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage();
  let path;
  await assert.rejects(
    f.store.assign(handle, scope(), async (paths) => {
      path = paths[0];
      throw new Error("lost native acknowledgement");
    }),
    /lost native acknowledgement/u,
  );
  assert((await readFile(path)).length > 0);
  await assert.rejects(
    f.store.assign(handle, scope(), async () => assert.fail("replay")),
    refused("stale"),
  );
});

test("close waits for a cancelled native effect and confirmed reader exit", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage();
  const entered = Promise.withResolvers(),
    released = Promise.withResolvers();
  let signal;
  const assignment = f.store.assign(handle, scope(), async (_paths, owner) => {
    signal = owner.signal;
    entered.resolve();
    await released.promise;
  });
  const failed = assert.rejects(assignment);
  await entered.promise;
  let closed = false;
  const closing = f.store.close().then(() => {
    closed = true;
  });
  assert(signal.aborted);
  f.store.readersExited();
  await tick();
  assert.equal(closed, false);
  released.resolve();
  await failed;
  await closing;
  assert.deepEqual(await readdir(f.directory), []);
});

test("content changed after staging never reaches the file chooser", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage(Buffer.from("approved"));
  const [path] = await f.paths();
  await chmod(path, 0o600);
  await writeFile(path, "attacker");
  await chmod(path, 0o400);
  await assert.rejects(
    f.store.assign(handle, scope(), async () => assert.fail("changed bytes assigned")),
    refused("identity"),
  );
  assert.deepEqual(await readdir(f.directory), []);
});

for (const replacement of ["symlink", "hardlink", "directory"])
  test(`${replacement} substitution refuses and never deletes a foreign file`, async (t) => {
    const f = await fixture(t);
    const handle = await f.stage();
    const [path] = await f.paths();
    const foreign = join(f.root, "foreign.txt");
    await writeFile(foreign, "foreign-canary");
    if (replacement === "hardlink") await link(path, join(f.root, "extra-link"));
    else {
      await rename(path, join(f.root, "original"));
      if (replacement === "symlink") await symlink(foreign, path);
      else await mkdir(path);
    }
    f.retirementFailure = true;
    await assert.rejects(
      f.store.assign(handle, scope(), async () => assert.fail("substituted path")),
      refused("identity"),
    );
    assert.equal(await readFile(foreign, "utf8"), "foreign-canary");
    await assert.rejects(f.stage(), refused("closed"));
  });

test("a replaced upload root is refused and cleanup remains descriptor-relative", async (t) => {
  const f = await fixture(t);
  const handle = await f.stage();
  await rename(f.directory, join(f.root, "old-uploads"));
  await mkdir(f.directory, { mode: 0o700 });
  await writeFile(join(f.directory, "foreign.txt"), "keep");
  await assert.rejects(
    f.store.assign(handle, scope(), async () => assert.fail("root changed")),
    refused("identity"),
  );
  assert.equal(await readFile(join(f.directory, "foreign.txt"), "utf8"), "keep");
  assert.deepEqual(await readdir(join(f.root, "old-uploads")), []);
});

async function targetFixture(t, f) {
  let receive;
  let origin = "https://example.test";
  const writes = [];
  const info = {
    targetId: "page",
    type: "page",
    title: "Upload",
    url: "https://example.test",
    attached: false,
  };
  const event = (method, params, sessionId) =>
    receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const targets = new BrowserTargets(
    {
      write(message) {
        const command = JSON.parse(message);
        writes.push(command);
        queueMicrotask(() => {
          if (command.method === "Target.setDiscoverTargets")
            event("Target.targetCreated", { targetInfo: info });
          if (command.method === "Target.setAutoAttach" && !command.sessionId)
            event("Target.attachedToTarget", {
              sessionId: "owned",
              targetInfo: info,
              waitingForDebugger: true,
            });
          receive(
            JSON.stringify({
              id: command.id,
              result:
                command.method === "Page.getFrameTree"
                  ? {
                      frameTree: {
                        frame: {
                          id: "frame",
                          securityOrigin: origin,
                          url: "https://example.test/private?token=hidden",
                        },
                      },
                    }
                  : {},
              ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            }),
          );
        });
      },
      close() {},
      onMessage(listener) {
        receive = listener;
        return () => {};
      },
      onClose() {
        return () => {};
      },
    },
    {
      downloadDir: "/downloads",
      uploadDir: f.directory,
      onFatal() {
        assert.fail("unexpected fence");
      },
    },
  );
  t.after(() => targets.close());
  await targets.start();
  const tab = targets.tabs()[0].id;
  const open = (mode = "selectSingle") =>
    event("Page.fileChooserOpened", { frameId: "frame", backendNodeId: 17, mode }, "owned");
  open();
  return {
    targets,
    tab,
    writes,
    open,
    setOrigin: (value) => {
      origin = value;
    },
  };
}

test("staged files pass through the real chooser owner and CDP path guard", async (t) => {
  const f = await fixture(t);
  const { targets, tab, writes } = await targetFixture(t, f);
  const chooser = targets.claimFileChooser(tab, targets.fileChooser(tab).id);
  const staged = await f.stage();
  await f.store.assign(staged, scope(), (paths, current) =>
    targets.fillFileChooser(chooser, paths, current),
  );
  const assignments = writes.filter((entry) => entry.method === "DOM.setFileInputFiles");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].params.backendNodeId, 17);
  assert.equal(basename(assignments[0].params.files[0]), "报告-report.txt");
  assert.equal(targets.fileChooser(tab), undefined);
});

async function serviceFixture(t) {
  const f = await fixture(t);
  const native = await targetFixture(t, f);
  const config = browserRuntimeConfig({
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000011",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000012",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: "1",
  });
  const instance = "b6adbffb-ad25-4d50-9297-5078b1d2cb4a";
  const permit = {
    browserCellId: config.browserCellId,
    parentCellId: config.parentCellId,
    instance,
    revision: 1,
    requestId: "01J00000000000000000000013",
    owner: { sessionId: "01J00000000000000000000014", generation: 1 },
  };
  const control = new BrowserControl({
    browserCellId: config.browserCellId,
    parentCellId: config.parentCellId,
    instance,
    clearSelections: async () => native.targets.clearFileChooser(),
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  native.open();
  const service = new BrowserUploadService({
    config,
    instance,
    control,
    targets: native.targets,
    openStaging: async () => f.store,
  });
  let retired,
    ready = true;
  const stop = () => {
    if (retired) return retired;
    ready = false;
    const closing = Promise.all([control.close(), service.close()]);
    service.readersExited();
    retired = closing.then(() => {});
    return retired;
  };
  const http = new BrowserHttp({
    config,
    instance,
    control,
    targets: native.targets,
    uploads: service,
    input: { inject: async () => {}, type: async () => {} },
    observation: { observe: async () => {} },
    ready: () => ready,
    stop,
    fence: () => {
      void stop();
    },
    retirement: () => retired,
  });
  await new Promise((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await stop();
    await http.close();
  });
  const port = http.server.address().port;
  const access = { permit, tabId: native.tab };
  const offer = await service.chooser(access, scope().signal);
  const data = Buffer.from("private approved source 中文");
  const raw = {
    ...access,
    chooserId: offer.id,
    destination: { origin: offer.origin, embedded: offer.embedded },
    files: [metadata(data)],
  };
  const start = (body = raw, headers = {}) => {
    let req;
    const allHeaders = {
      authorization: `Bearer ${config.serviceToken}`,
      "content-type": "application/octet-stream",
      "transfer-encoding": "chunked",
      "x-localdot-upload": Buffer.from(JSON.stringify(body)).toString("base64url"),
      ...headers,
    };
    for (const key of Object.keys(allHeaders))
      if (allHeaders[key] === undefined) delete allHeaders[key];
    const result = new Promise((resolve, reject) => {
      req = request(
        { hostname: "127.0.0.1", port, method: "POST", path: "/uploads/send", headers: allHeaders },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () => {
            try {
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
    });
    return { req, result };
  };
  const waitForFile = async () => {
    for (let i = 0; i < 500; i++) {
      if ((await readdir(f.directory)).length) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("staging never started");
  };
  return { ...f, ...native, service, control, http, access, permit, raw, data, start, waitForFile };
}

test("authenticated binary HTTP assigns once only after chunked EOF", async (t) => {
  const f = await serviceFixture(t);
  const { req, result } = f.start();
  req.write(f.data);
  await f.waitForFile();
  await tick();
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
  req.end();
  const reply = await result;
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, {
    chooserId: f.raw.chooserId,
    destination: f.raw.destination,
    files: f.raw.files,
  });
  const assignments = f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles");
  assert.equal(assignments.length, 1);
  assert.deepEqual(await readFile(assignments[0].params.files[0]), f.data);
  assert.equal(await f.service.chooser(f.access, scope().signal), undefined);
});

test("takeover drains an incomplete HTTP upload before granting control", async (t) => {
  const f = await serviceFixture(t);
  const { req, result } = f.start();
  const failed = assert.rejects(result);
  req.write(f.data.subarray(0, 2));
  await f.waitForFile();
  const { owner: _owner, ...identity } = f.permit;
  await f.control.set({ ...identity, revision: 2, holder: "user" });
  await failed;
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
});

for (const kind of ["origin", "embedded"])
  test(`the upload refuses an unapproved receiving ${kind} before staging`, async (t) => {
    const f = await serviceFixture(t);
    const destination = {
      ...f.raw.destination,
      ...(kind === "origin" ? { origin: "https://other.test" } : { embedded: true }),
    };
    const attempt = f.start({ ...f.raw, destination });
    attempt.req.end(f.data);
    const reply = await attempt.result.catch(() => null);
    assert(reply === null || reply.status >= 400);
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
  });

test("receiving origin is checked again after all uploaded bytes arrive", async (t) => {
  const f = await serviceFixture(t);
  const { req, result } = f.start();
  req.write(f.data);
  await f.waitForFile();
  f.setOrigin("https://changed.test");
  req.end();
  const reply = await result.catch(() => null);
  assert(reply === null || reply.status >= 400);
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
});

test("disconnect before EOF cancels uploaded bytes without native assignment", async (t) => {
  const f = await serviceFixture(t);
  const { req, result } = f.start();
  const failed = assert.rejects(result);
  req.write(f.data);
  await f.waitForFile();
  req.destroy(new Error("source changed before final validation"));
  await failed;
  await f.service.close();
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
});

for (const [label, headers] of [
  ["bad authentication", { authorization: "Bearer wrong" }],
  ["browser origin", { origin: "https://example.test" }],
  ["compressed stream", { "content-encoding": "gzip" }],
  ["malformed metadata", { "x-localdot-upload": "!invalid" }],
  [
    "Content-Length instead of final EOF",
    { "transfer-encoding": undefined, "content-length": "0" },
  ],
])
  test(`${label} refuses before the upload service receives bytes`, async (t) => {
    const f = await serviceFixture(t);
    const { req, result } = f.start(f.raw, headers);
    req.end();
    const reply = await result.catch(() => null);
    assert(reply === null || reply.status >= 400);
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 0);
  });

test("a permit from a replaced generation cannot claim the current chooser", async (t) => {
  const f = await serviceFixture(t);
  const changed = {
    ...f.raw,
    permit: { ...f.permit, owner: { ...f.permit.owner, generation: 2 } },
  };
  const { req, result } = f.start(changed);
  req.end(f.data);
  const reply = await result.catch(() => null);
  assert(reply === null || reply.status >= 400);
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await f.service.chooser(f.access, scope().signal)).id, f.raw.chooserId);
});

test("chooser HTTP metadata exposes its exact receiving origin but no private URL or node data", async (t) => {
  const f = await serviceFixture(t);
  const reply = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: f.http.server.address().port,
        method: "POST",
        path: "/uploads/chooser",
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify(f.access));
  });
  assert.deepEqual(reply, {
    status: 200,
    body: {
      chooser: {
        id: f.raw.chooserId,
        mode: "single",
        origin: "https://example.test",
        embedded: false,
      },
    },
  });
});

test("an empty file can be assigned through explicit chunked EOF, but cannot be replayed", async (t) => {
  const f = await serviceFixture(t);
  const raw = { ...f.raw, files: [metadata(Buffer.alloc(0))] };
  const first = f.start(raw);
  first.req.end();
  assert.equal((await first.result).status, 200);
  const second = f.start(raw);
  second.req.end();
  const reply = await second.result.catch(() => null);
  assert(reply === null || reply.status >= 400);
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 1);
  assert.equal((await readFile((await f.paths())[0])).length, 0);
});

test("agent-supplied browser paths and node IDs are rejected at the wire boundary", async (t) => {
  const f = await serviceFixture(t);
  for (const extra of [{ backendNodeId: 17 }, { path: "/profile/chromium/Cookies" }]) {
    const attempt = f.start({ ...f.raw, ...extra });
    attempt.req.end();
    const reply = await attempt.result;
    assert.equal(reply.status, 400);
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await f.service.chooser(f.access, scope().signal)).id, f.raw.chooserId);
});

test("approved desktop bytes traverse both authenticated services and the production clients", async (t) => {
  const f = await serviceFixture(t);
  const home = join(f.root, "desktop");
  await mkdir(home, { mode: 0o700 });
  const path = join(home, "source-中文.bin"),
    data = Buffer.alloc(200000, 73);
  await writeFile(path, data, { mode: 0o600 });
  const desktop = createDesktopdApp({
    token: "a".repeat(43),
    scale: 1,
    display: ":1",
    readXsettings: async () => null,
    readScreen: async () => null,
    tools: {
      home,
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
  let server,
    mutateDuringRead = false;
  await new Promise((resolve) => {
    server = serve(
      {
        fetch: async (request) => {
          const response = await desktop.fetch(request);
          if (
            !mutateDuringRead ||
            !request.url.endsWith("/files/upload-read") ||
            response.status !== 200
          )
            return response;
          const reader = response.body.getReader();
          let changed = false;
          return new Response(
            new ReadableStream(
              {
                async pull(controller) {
                  try {
                    const next = await reader.read();
                    if (next.done) {
                      reader.releaseLock();
                      controller.close();
                      return;
                    }
                    // Controlled concurrent writer: preserve bytes, change identity after
                    // source reading starts, and let the real final validation fail.
                    if (!changed) {
                      changed = true;
                      await writeFile(path, data);
                    }
                    controller.enqueue(next.value);
                  } catch (error) {
                    reader.releaseLock();
                    controller.error(error);
                  }
                },
                async cancel() {
                  await reader.cancel().catch(() => {});
                  reader.releaseLock();
                },
              },
              { highWaterMark: 0 },
            ),
            { status: response.status, headers: response.headers },
          );
        },
        port: 0,
        hostname: "127.0.0.1",
      },
      resolve,
    );
  });
  const tools = new DesktopdTools({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "a".repeat(43),
  });
  const client = new BrowserClient({
    ...f.permit,
    browserd: {
      baseUrl: `http://127.0.0.1:${f.http.server.address().port}`,
      token: "a".repeat(43),
    },
  });
  t.after(async () => {
    client.close();
    await tools.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const approved = await tools.inspectUpload("~/source-中文.bin");
  const chooser = await client.uploadChooser(f.permit, f.tab, scope());
  const files = [{ name: approved.name, bytes: approved.bytes, sha256: approved.sha256 }];
  const receipt = await client.upload(
    {
      permit: f.permit,
      tabId: f.tab,
      chooserId: chooser.id,
      destination: f.raw.destination,
      files,
    },
    tools.readUpload(approved),
    scope(),
  );
  assert.deepEqual(receipt, { chooserId: chooser.id, destination: f.raw.destination, files });
  const assignments = f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles");
  assert.equal(assignments.length, 1);
  assert.deepEqual(await readFile(assignments[0].params.files[0]), data);
  assert.equal(basename(assignments[0].params.files[0]), "source-中文.bin");

  f.open();
  const next = await client.uploadChooser(f.permit, f.tab, scope());
  await writeFile(path, data); // Unchanged bytes still cannot reuse an earlier file identity.
  await assert.rejects(
    client.upload(
      { permit: f.permit, tabId: f.tab, chooserId: next.id, destination: f.raw.destination, files },
      tools.readUpload(approved),
      scope(),
    ),
  );
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 1);
  const refreshed = await tools.inspectUpload("~/source-中文.bin");
  f.open();
  const final = await client.uploadChooser(f.permit, f.tab, scope());
  mutateDuringRead = true;
  await assert.rejects(
    client.upload(
      {
        permit: f.permit,
        tabId: f.tab,
        chooserId: final.id,
        destination: f.raw.destination,
        files,
      },
      tools.readUpload(refreshed),
      scope(),
    ),
  );
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 1);

  // The agent's sequential source adapter also uses the real authenticated
  // desktop transport, including empty files between nonempty files.
  mutateDuringRead = false;
  await writeFile(join(home, "empty.txt"), Buffer.alloc(0), { mode: 0o600 });
  await writeFile(join(home, "last.txt"), "final bytes", { mode: 0o600 });
  const selected = await Promise.all(
    ["~/source-中文.bin", "~/empty.txt", "~/last.txt"].map((name) => tools.inspectUpload(name)),
  );
  const multipleFiles = selected.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  f.open("selectMultiple");
  const multiple = await client.uploadChooser(f.permit, f.tab, scope());
  const combined = desktopUploadStream(tools, selected, scope());
  const done = await client.upload(
    {
      permit: f.permit,
      tabId: f.tab,
      chooserId: multiple.id,
      destination: f.raw.destination,
      files: multipleFiles,
    },
    combined,
    scope(),
  );
  assert.deepEqual(done.files, multipleFiles);
  assert(combined.destroyed);
  const finalAssignments = f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles");
  assert.equal(finalAssignments.length, 2);
  assert.deepEqual(
    await Promise.all(finalAssignments[1].params.files.map((file) => readFile(file))),
    [data, Buffer.alloc(0), Buffer.from("final bytes")],
  );
  f.open("selectMultiple");
  const changed = await client.uploadChooser(f.permit, f.tab, scope());
  await writeFile(join(home, "last.txt"), "changed after approval");
  await assert.rejects(
    client.upload(
      {
        permit: f.permit,
        tabId: f.tab,
        chooserId: changed.id,
        destination: f.raw.destination,
        files: multipleFiles,
      },
      desktopUploadStream(tools, selected, scope()),
      scope(),
    ),
  );
  assert.equal(f.writes.filter((entry) => entry.method === "DOM.setFileInputFiles").length, 2);
});
