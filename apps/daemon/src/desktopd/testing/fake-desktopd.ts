import type {
  HitTestResult,
  InputResult,
  ObserveResult,
  SettleResult,
  TypeProgress,
  TypeResult,
} from "@localdot/protocol";
import { Hono } from "hono";

export interface FakeScript {
  input?: (body: unknown) => InputResult | { status: number; body: string };
  type?: (
    body: unknown,
  ) => { progress: TypeProgress[]; result: TypeResult } | { status: number; body: string };
  settle?: () => SettleResult;
  observe?: () => ObserveResult;
  hitTest?: (point: { x: number; y: number }) => HitTestResult;
  focused?: () => HitTestResult;
  find?: (req: unknown) => HitTestResult;
  launch?: (body: unknown) => { pid: number };
  // The PNG for a /zoom request, or undefined for a frame the fake no longer keeps (404).
  zoom?: (body: unknown) => Buffer | undefined;
  clockDelayMs?: number;
  // A long string still typing: /type sends its progress lines, then nothing until the request ends.
  typeHolds?: boolean;
  // A held or repeated key still pressing: /input sends this many presses' lines, then nothing
  // until the request ends, as a Stop ends it.
  inputHolds?: number;
  // How long /release takes before it answers (and is recorded).
  releaseMs?: number;
}

export class FakeDesktopd {
  readonly app = new Hono();
  readonly calls: { path: string; body: unknown }[] = [];
  readonly token = "d".repeat(43);
  script: FakeScript;
  #mono = 50_000;
  // Where the fake's pointer is: the last /input point, as a real desktop's would be after a click.
  pointer = { x: 0, y: 0 };

  constructor(script: FakeScript = {}) {
    this.script = script;
    this.app.use("*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${this.token}`)
        return c.text("unauthorized", 401);
      await next();
    });
    this.app.get("/clock", async (c) => {
      if (this.script.clockDelayMs)
        await new Promise((r) => setTimeout(r, this.script.clockDelayMs));
      return c.json({ mono: this.mono() });
    });
    this.app.post("/input", async (c) => {
      const body = (await c.req.json()) as {
        input?: {
          kind?: string;
          at?: { x: number; y: number };
          to?: { x: number; y: number };
          repeat?: number;
          holdMs?: number;
        };
      };
      this.calls.push({ path: "/input", body });
      const at = body.input?.kind === "move" ? body.input.to : body.input?.at;
      if (at) this.pointer = { x: at.x, y: at.y };
      const armedMono = this.mono();
      const long = body.input?.kind === "key" && (body.input.repeat || body.input.holdMs);
      const count = long ? (body.input?.holdMs ? 1 : (body.input?.repeat ?? 1)) : 1;
      const presses = Array.from({ length: count }, () => this.mono());
      const out = this.script.input?.(body) ?? {
        pressMono: presses[0] as number,
        presses,
        injector: "xtest",
        armedMono,
      };
      if ("status" in out) return c.text(out.body, out.status as 500);
      if (!long) return c.json(out);
      const lines = out.presses.map((pressMono, i) => ({ presses: i + 1, pressMono }));
      const ndjson = (ls: unknown[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");
      const headers = { "content-type": "application/x-ndjson" };
      const holds = this.script.inputHolds;
      if (holds === undefined)
        return new Response(ndjson([...lines, { ...out, done: true }]), { headers });
      const signal = c.req.raw.signal;
      const sent = new TextEncoder().encode(ndjson(lines.slice(0, holds)));
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sent);
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(held, { headers });
    });
    this.app.post("/type", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/type", body });
      const out = this.script.type?.(body);
      if (out && "status" in out) return c.text(out.body, out.status as 500);
      const lines = out
        ? [...out.progress, out.result]
        : [
            {
              done: true,
              count: 0,
              firstPressMono: null,
              injector: "xtest",
              armedMono: this.mono(),
            },
          ];
      const ndjson = (ls: unknown[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");
      const headers = { "content-type": "application/x-ndjson" };
      if (!this.script.typeHolds) return new Response(ndjson(lines), { headers });
      const signal = c.req.raw.signal;
      const progress = new TextEncoder().encode(ndjson(out?.progress ?? []));
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(progress);
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(held, { headers });
    });
    this.app.post("/settle", async (c) => {
      this.calls.push({ path: "/settle", body: await c.req.json().catch(() => null) });
      return c.json(
        this.script.settle?.() ?? {
          changed: [],
          lastChangeMono: null,
          quiet: true,
          noVisibleChange: true,
        },
      );
    });
    this.app.post("/arm", (c) => c.json({ mono: this.mono() }));
    this.app.post("/release", async (c) => {
      if (this.script.releaseMs) await new Promise((r) => setTimeout(r, this.script.releaseMs));
      this.calls.push({ path: "/release", body: null });
      return c.json({ keys: 0, buttons: 0 });
    });
    this.app.post("/launch", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/launch", body });
      return c.json({ ...(this.script.launch?.(body) ?? { pid: 1234 }), armedMono: this.mono() });
    });
    this.app.post("/observe", (c) => {
      this.calls.push({ path: "/observe", body: null });
      return c.json(
        this.script.observe?.() ?? {
          frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
          width: 1280,
          height: 800,
          image: Buffer.from("RIFF....WEBP").toString("base64"),
          pointer: this.pointer,
          windows: [],
        },
      );
    });
    this.app.post("/zoom", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/zoom", body });
      const png = this.script.zoom?.(body);
      return png
        ? c.body(new Uint8Array(png), 200, { "content-type": "image/png" })
        : c.text("that frame is no longer kept", 404);
    });
    this.app.post("/hitTest", async (c) => {
      const body = (await c.req.json()) as { point: { x: number; y: number } };
      this.calls.push({ path: "/hitTest", body });
      return c.json(this.script.hitTest?.(body.point) ?? { target: null, window: null, ms: 1 });
    });
    this.app.post("/focused", (c) => {
      this.calls.push({ path: "/focused", body: null });
      return c.json(
        this.script.focused?.() ??
          this.script.hitTest?.(this.pointer) ?? {
            target: { point: this.pointer, source: "ax", role: "text", name: "Plain field" },
            window: 77,
            ms: 1,
          },
      );
    });
    this.app.post("/find", async (c) => {
      const body = await c.req.json();
      this.calls.push({ path: "/find", body });
      return c.json(this.script.find?.(body) ?? { target: null, window: null, ms: 1 });
    });
  }

  mono(): number {
    this.#mono += 1;
    return this.#mono;
  }

  get fetchImpl(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) =>
      this.app.fetch(new Request(input, init))) as typeof fetch;
  }
}
