import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RemoteLinks } from "../../../daemon/src/remote/links.ts";
import { type GuestGrant, guestPermits } from "./guest.ts";

const OWN = "01M4DBVBR6MWMZ3N8M49NW7T9J";
const CELL = "01M4DBVBQWQE768FVBPRNT79JD";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const PATHS = [
  "/api/whoami",
  "/api/clock",
  "/api/remote-session",
  "/api/remote-session/model",
  "/api/cells",
  "/api/runtime",
  "/api/conversation",
  "/api/conversation/new",
  "/api/conversation/continue",
  "/api/conversations",
  "/api/events",
  "/api/exports",
  "/api/voice",
  "/api/keyd",
  "/api/agent/settings",
  "/api/agent/providers",
  "/api/session-index",
  "/api/sessions",
  "/api/app-update",
  "/api/notify/attention",
  "/api/browser/engine",
  `/api/cells/${CELL}`,
  `/api/cells/${CELL}/live`,
  `/api/cells/${CELL}/status`,
  `/api/cells/${CELL}/agent`,
  `/api/cells/${CELL}/stream-ticket`,
  `/api/cells/${CELL}/browser-stream-ticket`,
  `/api/cells/${CELL}/uploads`,
  `/api/cells/${CELL}/start`,
  `/api/browsers/${CELL}`,
  `/api/browsers/${CELL}/status`,
  `/api/agent/sessions/${OWN}`,
  `/api/agent/sessions/${OWN}/messages`,
  `/api/agent/sessions/${OWN}/stop`,
  `/api/agent/sessions/${OWN}/answer`,
  `/api/agent/sessions/${OWN}/approve`,
  `/api/agent/sessions/${OWN}/model`,
  `/api/agent/sessions/${OWN}/proof`,
  `/api/agent/sessions/${OWN}/side-question`,
  `/api/agent/sessions/${OWN}/files/summary.md/versions`,
  `/api/sessions/${OWN}/events`,
  `/api/sessions/${OWN}/history`,
  `/api/sessions/${OWN}/stream`,
  `/api/sessions/${OWN}/clock`,
  `/api/sessions/${OWN}/card`,
  `/api/sessions/${OWN}/frames/000001`,
  `/api/sessions/${OWN}/thumbnail`,
];

// The page asks only for what the daemon would let its link have, for a task of the link's own.
test.each([
  {},
  { replay: true },
  { apps: true },
  { chooseModel: true, settings: true },
  { replay: true, apps: true, chooseModel: true, settings: true },
])("the page's rules for a link match the daemon's (%o)", (options) => {
  const home = mkdtempSync(join(tmpdir(), "guest-rules-"));
  homes.push(home);
  const links = new RemoteLinks(home);
  const model = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const { grant } = links.create({
    label: "Alex",
    expiresInHours: 1,
    maxTasks: 5,
    model,
    models: [model],
    ...options,
  });
  links.reserve(grant.id).finish(OWN);
  const row = links.active(grant.id);
  if (!row) throw new Error("The link is not active");
  const page: GuestGrant = { ...grant, ownedSessions: [OWN] };
  for (const method of ["GET", "POST", "PUT", "DELETE"])
    for (const path of PATHS)
      expect(guestPermits(page, method, path), `${method} ${path}`).toBe(
        links.permits(row, method, path),
      );
  links.close();
});

test("a task that is not the link's own takes none of its messages", () => {
  const grant = { ownedSessions: [] } as unknown as GuestGrant;
  expect(guestPermits(grant, "POST", `/api/agent/sessions/${OWN}/messages`)).toBe(false);
  expect(
    guestPermits(
      { ...grant, ownedSessions: [OWN] },
      "POST",
      `/api/agent/sessions/${OWN}/stop?giveBack=1`,
    ),
  ).toBe(true);
});
