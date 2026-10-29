import { randomBytes } from "node:crypto";
import type { AddDotRequest, DotJob, DotSummary } from "@localdot/protocol";
import type { createApp } from "../../../daemon/src/app.ts";
import { DotsError, type DotsRoutesDeps } from "../../../daemon/src/dots/routes.ts";

// The dots on the fixture's computer, kept in memory: jobs move on by timers, a sign-in goes to a
// page of the fixture's own, and what the page asked for is kept for the tests to read.
export interface FakeDotsEffects {
  added: AddDotRequest[];
  started: string[];
  stopped: string[];
  removed: { id: string; deleteData: boolean }[];
  passphrases: number;
  cancelled: number;
  signIns: string[];
  memoryWarnings: number;
}

export const MEMORY_ADVICE_TEXT =
  "Two running computers need about 10 GB for Docker; it has 8 GB. Raise it in Docker Desktop → Settings → Resources.";

const STEP_MS = 250;
const CODE = "d".repeat(43);

export function fakeDots(sealKey: string) {
  const dots: DotSummary[] = [
    { id: "main", name: "Main", port: 4750, self: true, main: true, state: "running" },
    { id: "work", name: "Work", port: 5750, self: false, main: false, state: "stopped" },
  ];
  const jobs = new Map<string, DotJob>();
  const effects: FakeDotsEffects = {
    added: [],
    started: [],
    stopped: [],
    removed: [],
    passphrases: 0,
    cancelled: 0,
    signIns: [],
    memoryWarnings: 0,
  };
  let askPassphrase = false;
  let memoryShort = false;

  const find = (id: string) => {
    const dot = dots.find((each) => each.id === id);
    if (!dot) throw new DotsError(404, "There's no dot by that name on this computer.");
    return dot;
  };
  const begin = (kind: DotJob["kind"], dot: string | undefined, step: string): DotJob => {
    const job: DotJob = {
      id: randomBytes(16).toString("base64url"),
      kind,
      state: "running",
      step,
      ...(dot ? { dot } : {}),
    };
    jobs.set(job.id, job);
    return job;
  };
  const later = (job: DotJob, change: Partial<DotJob>, then?: () => void) =>
    setTimeout(() => {
      jobs.set(job.id, { ...(jobs.get(job.id) ?? job), ...change });
      then?.();
    }, STEP_MS).unref();
  const idOf = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(?![a-z])/, "dot-")
      .slice(0, 24);

  const deps: DotsRoutesDeps = {
    list: async () => ({ dots: dots.map((dot) => ({ ...dot })), manage: true }),
    add(request) {
      effects.added.push(request);
      const id = idOf(request.name);
      if (dots.some((dot) => dot.id === id))
        throw new DotsError(409, `There's already a dot called ${request.name}.`);
      const job = begin("add", id, "Making its folder and ports");
      const waiting = askPassphrase;
      askPassphrase = false;
      later(job, { step: `Copying from ${request.from ?? "nothing"}` }, () => {
        dots.push({
          id,
          name: request.name,
          port: 4750 + 1000 * dots.length,
          self: false,
          main: false,
          state: "running",
        });
        later(
          job,
          waiting
            ? { state: "needs-passphrase", step: "Waiting for a passphrase", sealKey }
            : { state: "done", step: "Ready" },
        );
      });
      return job;
    },
    job: (id) => jobs.get(id),
    passphrase(id, _sealed) {
      const job = jobs.get(id);
      if (job?.state !== "needs-passphrase") throw new DotsError(409, "Nothing is waiting.");
      effects.passphrases += 1;
      const next: DotJob = { ...job, state: "running", step: "Copying keys" };
      delete next.sealKey;
      jobs.set(id, next);
      later(next, { state: "done", step: "Ready" });
      return next;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (job?.state !== "needs-passphrase") throw new DotsError(409, "Nothing is waiting.");
      effects.cancelled += 1;
      const next: DotJob = { ...job, state: "running", step: "Cancelling" };
      delete next.sealKey;
      jobs.set(id, next);
      later(next, { state: "failed", error: "Adding it was cancelled." });
      return next;
    },
    start(id) {
      const dot = find(id);
      effects.started.push(id);
      const job = begin("start", id, `Starting ${dot.name}`);
      later(job, { state: "done", step: "Running" }, () => {
        dot.state = "running";
      });
      return job;
    },
    stop(id) {
      const dot = find(id);
      effects.stopped.push(id);
      const job = begin("stop", id, `Stopping ${dot.name}`);
      later(job, { state: "done", step: "Stopped" }, () => {
        dot.state = "stopped";
      });
      return job;
    },
    async remove(id, deleteData, pageOrigin) {
      const dot = find(id);
      if (dot.main)
        throw new DotsError(409, "The first dot goes only when localDot is uninstalled.");
      effects.removed.push({ id, deleteData });
      const job = begin("remove", id, `Removing ${dot.name}`);
      later(job, { state: "done", step: "Removed" }, () => {
        dots.splice(dots.indexOf(dot), 1);
      });
      const main = dots.find((each) => each.main);
      return dot.self && main
        ? { job, next: `${pageOrigin}/__qa/switched?dot=${main.id}#code=${CODE}` }
        : { job };
    },
    async signIn(id, pageOrigin) {
      const dot = find(id);
      if (dot.state !== "running") throw new DotsError(409, `${dot.name} isn't running.`);
      effects.signIns.push(id);
      return { url: `${pageOrigin}/__qa/switched?dot=${id}#code=${CODE}` };
    },
  };

  // Another dot's computer runs and Docker's memory can't hold one more (cells' capacity check).
  const capacity = async () => {
    if (!memoryShort) return undefined;
    effects.memoryWarnings += 1;
    return MEMORY_ADVICE_TEXT;
  };

  // POST /__qa/dots/memory: Docker's memory is short for one more computer from now on.
  // POST /__qa/dots/passphrase: the next dot added waits for its own passphrase.
  // POST /__qa/dots/self/<id>: the page belongs to that dot instead.
  // GET /__qa/switched: where a switch lands, in place of the other dot's own address.
  const qa = (routes: ReturnType<typeof createApp>) => {
    routes.post("/__qa/dots/memory", (c) => {
      memoryShort = true;
      return c.json({ ok: true });
    });
    routes.post("/__qa/dots/passphrase", (c) => {
      askPassphrase = true;
      return c.json({ ok: true });
    });
    routes.post("/__qa/dots/self/:id", (c) => {
      const id = c.req.param("id");
      if (!dots.some((dot) => dot.id === id)) return c.text("unknown dot", 404);
      for (const dot of dots) dot.self = dot.id === id;
      return c.json({ ok: true });
    });
    routes.get("/__qa/dots", (c) => c.json({ dots, effects }));
    routes.get("/__qa/switched", (c) =>
      c.html(
        `<!doctype html><title>Switched</title><p>Switched to ${(c.req.query("dot") ?? "").replace(/[^a-z0-9-]/g, "")}</p>`,
      ),
    );
  };

  return { deps, qa, effects, capacity };
}
