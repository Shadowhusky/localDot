import { once } from "node:events";
import type { Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import type { PreviewListener } from "@localdot/protocol";
import { expect, test } from "@playwright/test";
import { createPreviewForwarder } from "../../../../cells/desktop/desktopd/src/preview-forwarder.ts";
import {
  type CellEndpoints,
  type CellSummary,
  NO_STREAM,
} from "../../../daemon/src/cells/types.ts";
import { previewFronts } from "../../../daemon/src/previews/fronts.ts";
import { Previews } from "../../../daemon/src/previews/previews.ts";
import { REFUSED, signInApp, signInService } from "../../../daemon/src/previews/testing/sign-in.ts";

// A sign-in round trip in a real browser: the daemon's previews and desktopd's forwarder, with an
// app and a provider that accepts only the app's registered address. Only the Mac's browsers run
// it: a phone has no way to the Mac's localhost.
const CELL = "01JXYZ0000000000000000CELL";
const SESSION = "01JXYZ0000000000000000TASK";
const TOKEN = "t".repeat(43);
const cleanup: (() => unknown)[] = [];

test.beforeEach(() => {
  test.skip(!["c14", "w14"].includes(test.info().project.name), "Runs at c14 and w14");
});

test.afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listening(server: Server | ReturnType<typeof createTcpServer>, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  cleanup.push(() => {
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

// A loopback port nothing listens on, taken and let go.
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function previewsOf(running: PreviewListener[]) {
  const forwarder = createPreviewForwarder({
    token: TOKEN,
    addresses: () => ["172.20.0.11"],
    ownPorts: new Set([7700]),
    listening: async () => running,
  });
  const preview = { port: await listening(forwarder), token: TOKEN };
  const cell: CellSummary = {
    id: CELL,
    state: "ready",
    scale: 2,
    createdAt: "2026-11-09T00:00:00.000Z",
    stream: NO_STREAM,
  };
  const previews = new Previews({
    range: { from: 64_990, to: 64_991 },
    cells: {
      get: (id) => (id === CELL ? cell : undefined),
      endpoints: (id): CellEndpoints | undefined =>
        id === CELL
          ? {
              desktopd: { baseUrl: "http://127.0.0.1:1", token: TOKEN },
              stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
              preview,
            }
          : undefined,
      subscribe: () => () => {},
      list: () => [cell],
    },
    cellOf: (id) => (id === SESSION ? CELL : undefined),
    fronts: async () => previewFronts([], { state: "not-running", message: "Tailscale is off." }),
  });
  cleanup.push(() => previews.close());
  return previews;
}

test("an app signs in when its preview opens on this Mac at the address its provider registered", async ({
  page,
}) => {
  const mac = await freePort();
  const registered = `http://localhost:${mac}`;
  const service = `http://127.0.0.1:${await listening(signInService(() => registered))}`;
  const app = signInApp(() => service);
  const port = await listening(app.server, "0.0.0.0");
  const previews = await previewsOf([{ address: "0.0.0.0", port, name: "node" }]);

  // Anywhere else, as at the tailnet preview's address, the provider refuses it.
  const elsewhere = new URL((await previews.open(SESSION, { port, local: mac })).open);
  elsewhere.hostname = "127.0.0.1";
  await page.goto(elsewhere.href);
  await expect(page).toHaveTitle("Thema (dev)");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.locator("body")).toContainText(JSON.stringify(REFUSED));

  const opened = await previews.open(SESSION, { port, local: mac });
  expect(new URL(opened.open).origin).toBe(registered);
  await page.goto(opened.open);
  await expect(page).toHaveTitle("Thema (dev)");
  expect(new URL(page.url()).origin).toBe(registered);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.locator("#who")).toHaveText("Signed in as owner@thema.test");
  expect(page.url()).toMatch(new RegExp(`^${registered}/callback\\?code=`));
  // The callback reached the app in the computer, addressed as the browser had it.
  const callback = app.seen.find((request) => request.url.startsWith("/callback?code="));
  expect(callback?.headers.host).toBe(`localhost:${mac}`);
});
