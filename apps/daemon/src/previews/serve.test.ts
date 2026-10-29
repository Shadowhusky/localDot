import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessLinks } from "../access-links.ts";
import { PreviewServe, ServeError } from "./serve.ts";

// A stand-in `tailscale` that answers from files beside it and logs each call.
const FAKE = `#!/bin/sh
dir=\${0%/*}
echo "$*" >> "$dir/calls.log"
case "$1 $2" in
"status "*) cat "$dir/status.json" ;;
"serve status") cat "$dir/serve.json" ;;
*) if [ -e "$dir/fail" ]; then echo "serve config denied" >&2; exit 1; fi ;;
esac
`;
const RUNNING = { BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } };
const RANGE = { from: 4900, to: 4915 };
const temps: string[] = [];
const links: AccessLinks[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function tailscale(serve: unknown, status: unknown = RUNNING) {
  const dir = mkdtempSync(join(tmpdir(), "localdot-preview-serve-"));
  temps.push(dir);
  writeFileSync(join(dir, "status.json"), JSON.stringify(status));
  writeFileSync(join(dir, "serve.json"), JSON.stringify(serve));
  writeFileSync(join(dir, "tailscale"), FAKE, { mode: 0o755 });
  const access = new AccessLinks(4750, dir, {
    commands: [join(dir, "tailscale")],
    host: { os: "linux", wsl: null },
  });
  links.push(access);
  const log = () =>
    existsSync(join(dir, "calls.log"))
      ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")
      : [];
  // localDot's own look at Tailscale, as at startup, before the previews' calls.
  await access.read();
  const before = log().length;
  return {
    serve: new PreviewServe((args) => access.runTailscale(args), RANGE),
    calls: () =>
      log()
        .slice(before)
        .filter((line) => !line.startsWith("status ")),
    fail: () => writeFileSync(join(dir, "fail"), ""),
  };
}

const web = (entries: Record<string, string>) => ({
  TCP: Object.fromEntries(
    Object.keys(entries).map((host) => [host.split(":")[1], { HTTPS: true }]),
  ),
  Web: Object.fromEntries(
    Object.entries(entries).map(([host, proxy]) => [host, { Handlers: { "/": { Proxy: proxy } } }]),
  ),
});

describe("Tailscale Serve for preview ports", () => {
  it("clears its own leftovers in its block once, then shares each port it holds", async () => {
    const fake = await tailscale(
      web({
        "pc.example.ts.net:4750": "http://127.0.0.1:4750",
        "pc.example.ts.net:4900": "http://127.0.0.1:4900",
        "pc.example.ts.net:4901": "http://127.0.0.1:3000",
        "pc.example.ts.net:4903": "http://127.0.0.1:4903",
        "pc.example.ts.net:4999": "http://127.0.0.1:4999",
      }),
    );
    await fake.serve.add(4902);
    await fake.serve.add(4904);
    expect(fake.calls()).toEqual([
      "serve status --json",
      "serve --https=4900 off",
      "serve --https=4903 off",
      "serve --bg --https=4902 http://127.0.0.1:4902",
      "serve --bg --https=4904 http://127.0.0.1:4904",
    ]);
  });

  it("removes only the entries it added, and all of them when localDot closes", async () => {
    const fake = await tailscale(web({}));
    await fake.serve.add(4900);
    await fake.serve.add(4901);
    await fake.serve.remove(4900);
    await fake.serve.remove(4905);
    await fake.serve.close();
    expect(fake.calls()).toEqual([
      "serve status --json",
      "serve --bg --https=4900 http://127.0.0.1:4900",
      "serve --bg --https=4901 http://127.0.0.1:4901",
      "serve --https=4900 off",
      "serve --https=4901 off",
    ]);
  });

  it("fails when Tailscale refuses or isn't connected, holding nothing", async () => {
    const refused = await tailscale(web({}));
    refused.fail();
    await expect(refused.serve.add(4900)).rejects.toBeInstanceOf(ServeError);
    await refused.serve.close();
    expect(refused.calls().filter((call) => call.endsWith("off"))).toEqual([]);
    const off = await tailscale(web({}), { BackendState: "Stopped" });
    await expect(off.serve.add(4900)).rejects.toThrow("Tailscale isn't connected");
    expect(off.calls()).toEqual([]);
  });
});
