import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DesktopContainer,
  launchInDesktop,
  startDesktopContainer,
  windowGeometry,
} from "../cells/testing/desktop-container.ts";
import { DOCKER_TESTS, removeAll, waitFor } from "../cells/testing/docker-cli.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { desktopSiteStorage } from "./desktop-storage.ts";

// The desktop's own Chromium, where dot opens the computer's servers, and an app on its port 3102
// that keeps its sign-in in the page's storage, as Thema's does.
const C = "localdot-test-site-storage";
const APP = "http://localhost:3102";
const SERVER = `require("node:http").createServer((_, reply) => {
  reply.setHeader("content-type", "text/html");
  reply.end("<title>App</title><script>localStorage.setItem('auth', 'signed-in')</script>");
}).listen(3102, "127.0.0.1")`;

describe.skipIf(!DOCKER_TESTS)("an app's saved sign-in, read for its preview", () => {
  let cell: DesktopContainer;
  let tools: DesktopdTools;
  const read = async (origins: string[]) => {
    const started = performance.now();
    const items = await desktopSiteStorage(tools, origins, AbortSignal.timeout(30_000));
    console.log(`read ${origins.join(" ")} in ${Math.round(performance.now() - started)} ms`);
    return items;
  };

  beforeAll(() => {
    cell = startDesktopContainer(C, 1);
    tools = new DesktopdTools({ baseUrl: cell.baseUrl, token: cell.token });
    launchInDesktop(C, "/usr/local/bin/node", "-e", SERVER);
  }, 600_000);
  afterAll(async () => {
    await tools?.close();
    removeAll({ containers: [C] });
  });

  it("reads nothing while no page of the app is open", async () => {
    expect(await read([APP])).toEqual([]);
  });

  it("reads it from the app's page in the desktop's Chromium, and only for that app", async () => {
    // Opened as dot opens it: Chromium on the desktop, then the app's address in it.
    const launched = await fetch(`${cell.baseUrl}/launch`, {
      method: "POST",
      headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" },
      body: JSON.stringify({ app: "chromium", args: ["file:///opt/localdot/marker.html"] }),
    });
    expect(launched.ok, await launched.text()).toBe(true);
    waitFor("chromium", () => windowGeometry(C, "chromium") !== undefined, 60_000);
    await expect
      .poll(
        () => tools.browserNavigate(`${APP}/`, AbortSignal.timeout(30_000)).catch(() => undefined),
        {
          timeout: 60_000,
          interval: 1000,
        },
      )
      .toMatchObject({ url: `${APP}/`, loaded: true });
    await expect
      .poll(() => read([APP, "http://127.0.0.1:3102"]), { timeout: 60_000, interval: 1000 })
      .toEqual([["auth", "signed-in"]]);
    expect(await read(["http://localhost:3103"])).toEqual([]);
    expect(await read(["http://127.0.0.1:3102"])).toEqual([]);
  }, 180_000);
});
