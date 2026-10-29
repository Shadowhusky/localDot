import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AddDotRequest,
  DOT_ID_PATTERN,
  DOT_JOB_PATTERN,
  type DotJob,
  DotPassphrase,
  type DotSelf,
  type DotSignIn,
  type DotsReply,
  type RemoveDotReply,
  RemoveDotRequest,
} from "../../../../packages/protocol/src/dots.ts";
import type { Sealed } from "../../../../packages/protocol/src/keyd.ts";

export class DotsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface DotsRoutesDeps {
  list(): Promise<DotsReply>;
  add(request: AddDotRequest): DotJob;
  job(id: string): DotJob | undefined;
  passphrase(job: string, sealed: Sealed): DotJob;
  // Gives up on an add that waits for a passphrase; it undoes what it made.
  cancel(job: string): DotJob;
  start(id: string): DotJob;
  stop(id: string): DotJob;
  remove(id: string, deleteData: boolean, pageOrigin: string): Promise<RemoveDotReply>;
  signIn(id: string, pageOrigin: string): Promise<DotSignIn>;
  // Asked by the other dots on this computer, with this dot's token.
  self?(): DotSelf;
}

// Where this browser reaches localDot, so a switch keeps to the same kind of address (this
// computer, or the tailnet).
function pageOrigin(c: Context): string {
  return c.req.header("origin") ?? new URL(c.req.url).origin;
}

async function run<T>(c: Context, act: () => T | Promise<T>, status: 200 | 202 = 200) {
  try {
    return c.json(await act(), status);
  } catch (error) {
    if (error instanceof DotsError) return c.text(error.message, error.status);
    throw error;
  }
}

export function dotsRoutes(app: Hono, dots: DotsRoutesDeps) {
  app.use("/api/dots/*", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/api/dots", bodyLimit({ maxSize: 4 * 1024 }));
  app.get("/api/dots", async (c) => {
    c.header("cache-control", "no-store");
    return run(c, () => dots.list());
  });
  app.post("/api/dots", async (c) => {
    const input = AddDotRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.text("Give the new dot a name of up to 40 characters.", 400);
    return run(c, () => dots.add(input.data), 202);
  });
  app.get("/api/dots/self", (c) => {
    c.header("cache-control", "no-store");
    return dots.self ? c.json(dots.self()) : c.text("unknown dot", 404);
  });
  app.get("/api/dots/jobs/:job", (c) => {
    c.header("cache-control", "no-store");
    const id = c.req.param("job");
    const job = DOT_JOB_PATTERN.test(id) ? dots.job(id) : undefined;
    return job ? c.json(job) : c.text("unknown job", 404);
  });
  app.post("/api/dots/jobs/:job/passphrase", async (c) => {
    const id = c.req.param("job");
    const input = DotPassphrase.safeParse(await c.req.json().catch(() => null));
    if (!DOT_JOB_PATTERN.test(id) || !input.success) return c.text("invalid request", 400);
    return run(c, () => dots.passphrase(id, input.data.sealed));
  });
  app.post("/api/dots/jobs/:job/cancel", async (c) => {
    const id = c.req.param("job");
    if (!DOT_JOB_PATTERN.test(id)) return c.text("unknown job", 404);
    return run(c, () => dots.cancel(id));
  });
  for (const operation of ["start", "stop"] as const) {
    app.post(`/api/dots/:id/${operation}`, async (c) => {
      const id = c.req.param("id");
      if (!DOT_ID_PATTERN.test(id)) return c.text("unknown dot", 404);
      return run(c, () => dots[operation](id), 202);
    });
  }
  app.post("/api/dots/:id/remove", async (c) => {
    const id = c.req.param("id");
    const input = RemoveDotRequest.safeParse(await c.req.json().catch(() => null));
    if (!DOT_ID_PATTERN.test(id)) return c.text("unknown dot", 404);
    if (!input.success) return c.text("invalid request", 400);
    return run(c, () => dots.remove(id, input.data.deleteData, pageOrigin(c)), 202);
  });
  app.post("/api/dots/:id/sign-in", async (c) => {
    const id = c.req.param("id");
    if (!DOT_ID_PATTERN.test(id)) return c.text("unknown dot", 404);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return run(c, () => dots.signIn(id, pageOrigin(c)));
  });
}
