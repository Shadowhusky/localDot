import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, fetch as transportFetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoPageError } from "../../../../cells/desktop/desktopd/src/tools/browser.ts";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import {
  DesktopdTools,
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "./tools-client.ts";

const token = "d".repeat(43);
const clients: DesktopdTools[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});
const client = (fetchImpl?: typeof fetch, limit?: number, baseUrl = "http://desktopd") => {
  const c = new DesktopdTools({ baseUrl, token }, fetchImpl, limit);
  clients.push(c);
  return c;
};
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
const bytes = (text: string) => new TextEncoder().encode(text);
const done = { done: true, exitCode: 0, signal: null, timedOut: false, truncated: false, ms: 1 };
const lines = (...values: unknown[]) => values.map((v) => `${JSON.stringify(v)}\n`).join("");
const answer = (value: Response | (() => Response)) =>
  vi.fn(async () => (typeof value === "function" ? value() : value)) as unknown as typeof fetch;
function setup(limit?: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "localdot-tools-")));
  homes.push(home);
  const app = new Hono();
  app.use("*", async (c, next) =>
    c.req.header("authorization") === `Bearer ${token}` ? next() : c.text("unauthorized", 401),
  );
  addToolRoutes(app, {
    home,
    env: { PATH: process.env.PATH },
    browser: {
      page: async () => ({ url: "https://accounts.google.com/signin" }),
      read: async () => {
        throw new NoPageError();
      },
      navigate: async (url) => ({ url, title: "Example", loaded: true }),
    },
    maxFetchBytes: limit,
    maxPutBytes: limit,
  });
  const tools = client(
    ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    limit,
  );
  return { tools, home };
}

describe("DesktopdTools real routes", () => {
  it("streams stdout/stderr and a nonzero exit", async () => {
    const { tools } = setup();
    const output: string[] = [];
    const result = await tools.shell({ command: "printf one; printf two >&2; exit 4" }, (c) => {
      output.push(`${c.stream}:${c.chunk}`);
    });
    expect(result.exitCode).toBe(4);
    expect(output.sort()).toEqual(["stderr:two", "stdout:one"]);
  });
  it("round trips text changes, listing and binary streams", async () => {
    const { tools } = setup();
    expect((await tools.writeFile("a.txt", "a\n")).op).toBe("create");
    expect((await tools.editFile("a.txt", "a", "b")).patch).toContain("+b");
    expect((await tools.readFile("a.txt")).content).toBe("b\n");
    expect((await tools.listDir("~")).entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(
      await tools.putFile("Downloads/data.bin", stream(new Uint8Array([1, 0, 255])), 0o644),
    ).toBe("~/Downloads/data.bin");
    expect([
      ...new Uint8Array(
        await new Response(await tools.fetchFile("Downloads/data.bin")).arrayBuffer(),
      ),
    ]).toEqual([1, 0, 255]);
  });
  it("preserves route refusals and browser results", async () => {
    const { tools } = setup();
    await expect(tools.readFile("../etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(tools.browserRead()).rejects.toMatchObject({ status: 409 });
    expect(await tools.browserPage()).toBe("https://accounts.google.com/signin");
    await expect(tools.browserNavigate("file:///etc/passwd")).rejects.toMatchObject({
      status: 400,
    });
    expect(await tools.browserNavigate("https://example.test/")).toEqual({
      url: "https://example.test/",
      title: "Example",
      loaded: true,
    });
  });
  it("carries create-only upload admission through the actual file route without replacing bytes", async () => {
    const { tools } = setup();
    expect(
      await tools.putFile(
        "Downloads/attachment.txt",
        stream(bytes("original")),
        undefined,
        undefined,
        true,
      ),
    ).toBe("~/Downloads/attachment.txt");
    await expect(
      tools.putFile(
        "Downloads/attachment.txt",
        stream(bytes("replacement")),
        undefined,
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await tools.readFile("Downloads/attachment.txt")).content).toBe("original");
  });
});

describe("tool transport ownership", () => {
  it("makes no call after pre-abort or closure", async () => {
    const fetch = answer(new Response("{}"));
    const tools = client(fetch);
    const stop = AbortSignal.abort();
    await expect(tools.readFile("x", undefined, stop)).rejects.toBeDefined();
    await expect(tools.shell({ command: "true" }, () => {}, stop)).rejects.toBeDefined();
    await tools.close();
    await expect(tools.browserRead()).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps silent body reading alive beyond five minutes, then receives a terminal result", async () => {
    vi.useFakeTimers();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const tools = client(
      answer(
        new Response(
          new ReadableStream({
            start(c) {
              body = c;
            },
          }),
        ),
      ),
    );
    let finished = false;
    const work = tools
      .shell({ command: "true", timeoutMs: 600_000 }, () => {})
      .then((r) => {
        finished = true;
        return r;
      });
    await vi.advanceTimersByTimeAsync(360_000);
    expect(finished).toBe(false);
    body.enqueue(bytes(lines(done)));
    body.close();
    expect(await work).toEqual(done);
  });
  it("expires a silent body at the explicit shell deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const tools = client(answer(new Response(new ReadableStream({ cancel }))));
    const work = tools.shell({ command: "true", timeoutMs: 600_000 }, () => {});
    const rejected = expect(work).rejects.toBeInstanceOf(ShellExecutionUncertainError);
    await vi.advanceTimersByTimeAsync(610_000);
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it("expires ignored header promises and closes silent bodies on Stop", async () => {
    vi.useFakeTimers();
    const tools = client(vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    const work = tools.browserRead();
    const rejected = expect(work).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    const cancel = vi.fn();
    const stop = new AbortController();
    const second = client(answer(new Response(new ReadableStream({ cancel }))));
    const shell = second.shell({ command: "true" }, () => {}, stop.signal);
    const stopped = expect(shell).rejects.toBeInstanceOf(ShellExecutionUncertainError);
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await stopped;
    expect(cancel).toHaveBeenCalled();
  });
  it("uses its production dispatcher instead of tiny global transport timeouts", async () => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (f: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        f();
      }, 1500);
      timers.add(t);
    };
    const server = createServer((req, res) => {
      const start = () => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.flushHeaders();
        later(() => res.end(lines(done)));
      };
      if (req.url === "/body") start();
      else later(start);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = getGlobalDispatcher();
    const tiny = new Agent({ headersTimeout: 5, bodyTimeout: 5 });
    setGlobalDispatcher(tiny);
    try {
      await expect(transportFetch(origin)).rejects.toBeDefined();
      await expect(
        transportFetch(`${origin}/body`).then((response) => response.arrayBuffer()),
      ).rejects.toBeDefined();
      expect(
        await client(undefined, undefined, origin).shell({ command: "true" }, () => {}),
      ).toEqual(done);
    } finally {
      setGlobalDispatcher(previous);
      for (const t of timers) clearTimeout(t);
      await tiny.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});

describe("shell NDJSON boundary", () => {
  it("decodes split UTF-8 and awaits output consumers", async () => {
    const encoded = bytes(lines({ stream: "stdout", chunk: "你好" }, done));
    const tools = client(
      answer(new Response(stream(encoded.subarray(0, 31), encoded.subarray(31)))),
    );
    const output: string[] = [];
    expect(
      await tools.shell({ command: "true" }, async (c) => {
        await Promise.resolve();
        output.push(c.chunk);
      }),
    ).toEqual(done);
    expect(output).toEqual(["你好"]);
  });
  it("preserves cleanup uncertainty before generic error handling", async () => {
    const tools = client(
      answer(new Response(lines({ error: "safe", status: 500, code: "shell_cleanup_uncertain" }))),
    );
    await expect(tools.shell({ command: "true" }, () => {})).rejects.toBeInstanceOf(
      ShellCleanupUncertainError,
    );
  });
  for (const [name, body] of [
    ["EOF", ""],
    ["null", "null\n"],
    ["malformed", "{\n"],
    ["partial final", JSON.stringify(done)],
    ["duplicate final", lines(done, done)],
    ["after final", lines(done, { stream: "stdout", chunk: "late" })],
    ["output overflow", lines({ stream: "stdout", chunk: "x".repeat(1025) }, done)],
  ])
    it(`rejects ${name} as uncertain, never success`, async () => {
      const tools = client(answer(new Response(body)));
      await expect(
        tools.shell({ command: "true", maxOutputBytes: 1024 }, () => {}),
      ).rejects.toBeInstanceOf(ShellExecutionUncertainError);
    });
  it("cancels on a rejected output callback", async () => {
    const cancel = vi.fn();
    const tools = client(
      answer(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes(lines({ stream: "stdout", chunk: "x" })));
            },
            cancel,
          }),
        ),
      ),
    );
    await expect(
      tools.shell({ command: "true" }, async () => {
        throw new Error("private callback reason");
      }),
    ).rejects.toBeInstanceOf(ShellExecutionUncertainError);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("bounded streaming transfer", () => {
  it("retains a finite response deadline when the peer cancels an unused upload body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const tools = client(async (_url, init) => {
      if (!(init?.body instanceof ReadableStream)) throw new Error("Owned upload stream missing");
      await init.body.cancel();
      return new Promise<Response>(() => {});
    });
    const call = tools.putFile("x", new ReadableStream<Uint8Array>({ cancel }));
    const rejected = expect(call).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces actual response bytes despite absent or false length", async () => {
    for (const headers of [{}, { "content-length": "1" }]) {
      const tools = client(
        answer(new Response(stream(bytes("1234"), bytes("56789")), { headers })),
        8,
      );
      await expect(new Response(await tools.fetchFile("x")).arrayBuffer()).rejects.toBeDefined();
    }
  });
  it("permits the exact limit and cancels its source if the consumer cancels", async () => {
    const tools = client(answer(new Response(stream(bytes("12345678")))), 8);
    expect(await new Response(await tools.fetchFile("x")).text()).toBe("12345678");
    const cancel = vi.fn();
    const other = client(answer(new Response(new ReadableStream({ cancel }))));
    await (await other.fetchFile("x")).cancel();
    expect(cancel).toHaveBeenCalled();
  });
  it("keeps deadlines active after returning headers even without a consumer", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const tools = client(answer(new Response(new ReadableStream({ cancel }))));
    const body = await tools.fetchFile("x");
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(new Response(body).arrayBuffer()).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
  });
  it("bounds upload streaming and never publishes a partial result", async () => {
    const { tools } = setup(8);
    await expect(tools.putFile("x", stream(bytes("1234"), bytes("56789")))).rejects.toBeDefined();
    expect((await tools.listDir("~")).entries).toEqual([]);
  });
});

describe("tool cancellation across every body owner", () => {
  for (const op of ["read", "write", "edit", "list", "browser-read", "navigate"] as const) {
    it(`cancels ${op} after headers without publishing a result`, async () => {
      const cancel = vi.fn();
      const stop = new AbortController();
      const tools = client(answer(new Response(new ReadableStream({ cancel }))));
      const calls = {
        read: () => tools.readFile("x", undefined, stop.signal),
        write: () => tools.writeFile("x", "text", stop.signal),
        edit: () => tools.editFile("x", "old", "new", stop.signal),
        list: () => tools.listDir("~", stop.signal),
        "browser-read": () => tools.browserRead(undefined, stop.signal),
        navigate: () => tools.browserNavigate("https://example.test", stop.signal),
      };
      const work = calls[op]();
      const failed = expect(work).rejects.toBeDefined();
      await new Promise((resolve) => setImmediate(resolve));
      stop.abort();
      await failed;
      expect(cancel).toHaveBeenCalled();
    });
  }
  it("handles an abort plus rejected output callback without an unhandled rejection", async () => {
    const stop = new AbortController();
    const tools = client(answer(new Response(lines({ stream: "stdout", chunk: "x" }, done))));
    await expect(
      tools.shell(
        { command: "true" },
        () => {
          stop.abort();
          return Promise.reject(new Error("callback failed"));
        },
        stop.signal,
      ),
    ).rejects.toBeInstanceOf(ShellExecutionUncertainError);
  });
  it("bounds outbound bytes even when the peer accepts oversized input", async () => {
    const tools = client(
      (async (_url, init) => {
        await new Response(init?.body as ReadableStream<Uint8Array>).arrayBuffer();
        return new Response(JSON.stringify({ path: "~/x", bytes: 0 }));
      }) as typeof fetch,
      8,
    );
    await expect(tools.putFile("x", stream(bytes("1234"), bytes("56789")))).rejects.toBeDefined();
  });
});

describe("reviewed transport boundaries", () => {
  it("does not trust DesktopdError thrown by an output consumer", async () => {
    const { DesktopdError } = await import("./client.ts");
    const tools = client(answer(new Response(lines({ stream: "stdout", chunk: "started" }, done))));
    await expect(
      tools.shell({ command: "true" }, () => {
        throw new DesktopdError(400, "consumer failed", "/consumer");
      }),
    ).rejects.toBeInstanceOf(ShellExecutionUncertainError);
  });
  it("rejects hybrid output and terminal records", async () => {
    const tools = client(
      answer(new Response(lines({ ...done, stream: "stdout", chunk: "hidden" }))),
    );
    await expect(tools.shell({ command: "true" }, () => {})).rejects.toBeInstanceOf(
      ShellExecutionUncertainError,
    );
    const other = client(
      answer(new Response(lines({ stream: "stdout", chunk: "hidden", unexpected: true }, done))),
    );
    await expect(other.shell({ command: "true" }, () => {})).rejects.toBeInstanceOf(
      ShellExecutionUncertainError,
    );
  });
  it("rejects a success reply before upload EOF and cancels the source", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes("first"));
      },
      cancel,
    });
    const tools = client(answer(Response.json({ path: "~/x", bytes: 5 })));
    await expect(tools.putFile("x", source)).rejects.toThrow("not acknowledged completely");
    expect(cancel).toHaveBeenCalled();
  });
  it("requires the upload acknowledgement to match actual bytes", async () => {
    const tools = client((async (_url, init) => {
      await new Response(init?.body).arrayBuffer();
      return Response.json({ path: "~/x", bytes: 2 });
    }) as typeof fetch);
    await expect(tools.putFile("x", stream(bytes("one")))).rejects.toThrow(
      "not acknowledged completely",
    );
  });
  it("cancels a body that an uncooperative transport returns after cancellation", async () => {
    let reply!: (r: Response) => void;
    const cancel = vi.fn();
    const tools = client(
      (() =>
        new Promise<Response>((r) => {
          reply = r;
        })) as typeof fetch,
    );
    const stop = new AbortController();
    const call = tools.readFile("x", undefined, stop.signal);
    const rejected = expect(call).rejects.toBeDefined();
    stop.abort();
    await rejected;
    reply(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed transport outcomes", () => {
  it("preserves a server refusal before shell output", async () => {
    const tools = client(answer(new Response("refused", { status: 403 })));
    await expect(tools.shell({ command: "true" }, () => {})).rejects.toMatchObject({ status: 403 });
  });
  it.each(["", "three"])("accepts complete exact-count uploads: %j", async (value) => {
    const tools = client((async (_url, init) => {
      const body = await new Response(init?.body).arrayBuffer();
      return Response.json({ path: "~/x", bytes: body.byteLength });
    }) as typeof fetch);
    await expect(tools.putFile("x", stream(bytes(value)))).resolves.toBe("~/x");
  });
});

it("treats an undefined output-consumer rejection as execution uncertainty", async () => {
  const tools = client(answer(new Response(lines({ stream: "stdout", chunk: "started" }, done))));
  await expect(tools.shell({ command: "true" }, () => Promise.reject())).rejects.toBeInstanceOf(
    ShellExecutionUncertainError,
  );
});
