import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessLinks,
  approvalUrl,
  backendProblem,
  type CommandResult,
  enableProblem,
  failedCommand,
  placeOf,
  servedOrigins,
  serveState,
  tailscaleCommands,
} from "./access-links.ts";
import { createApp } from "./app.ts";
import type { EventLog } from "./event-log.ts";
import { isAllowedHost } from "./guard.ts";

const status = { BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } };
const serve = (proxy = "http://127.0.0.1:4750") => ({
  TCP: { "4750": { HTTPS: true } },
  Web: { "pc.example.ts.net:4750": { Handlers: { "/": { Proxy: proxy } } } },
});
const ORIGIN = "https://pc.example.ts.net:4750";
const mac = { os: "macos", wsl: null } as const;
const linux = { os: "linux", wsl: null } as const;
const wsl = { os: "linux", wsl: 2 } as const;
const failed = (stderr: string, more: Partial<CommandResult> = {}): CommandResult => ({
  code: 1,
  stdout: "",
  stderr,
  ...more,
});

it("discovers only HTTPS routes to this app on the connected machine", () => {
  expect(servedOrigins(status, serve(), 4750)).toEqual([ORIGIN]);
  expect(servedOrigins(status, serve("http://127.0.0.1:8000"), 4750)).toEqual([]);
  expect(servedOrigins({ ...status, BackendState: "Stopped" }, serve(), 4750)).toEqual([]);
  expect(
    servedOrigins(status, { ...serve(), AllowFunnel: { "pc.example.ts.net:4750": true } }, 4750),
  ).toEqual([]);
  expect(servedOrigins(status, { ...serve(), TCP: { "4750": { HTTPS: false } } }, 4750)).toEqual(
    [],
  );
});

describe("finding Tailscale's command line", () => {
  it("looks where each platform installs it, Homebrew included, before the service's PATH", () => {
    expect(tailscaleCommands(mac, "/Users/me")).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Users/me/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    ]);
    expect(tailscaleCommands(wsl)[0]).toBe("/mnt/c/Program Files/Tailscale/tailscale.exe");
    expect(tailscaleCommands(wsl)).toContain("/usr/bin/tailscale");
    expect(tailscaleCommands(linux)).not.toContain("/mnt/c/Program Files/Tailscale/tailscale.exe");
  });
});

describe("Tailscale's state from what its command line prints", () => {
  const onMac = placeOf("/Applications/Tailscale.app/Contents/MacOS/Tailscale", mac);
  const onLinux = placeOf("/usr/bin/tailscale", linux);
  const onWindows = placeOf("/mnt/c/Program Files/Tailscale/tailscale.exe", wsl);

  it("tells apart not installed, not running and not answering, with the next step", () => {
    expect(failedCommand(failed("", { code: null, error: "ENOENT" }), onMac, mac)).toEqual({
      state: "not-installed",
      message: "Tailscale isn't installed on this Mac. Install it and sign in to use it here.",
    });
    expect(
      failedCommand(failed("", { code: null, error: "ENOENT" }), onLinux, wsl).message,
    ).toContain("isn't installed on Windows");
    expect(
      failedCommand(
        failed("failed to connect to local Tailscale service; is Tailscale running?\n"),
        onMac,
        mac,
      ),
    ).toEqual({
      state: "not-running",
      message: "Tailscale is installed but not running. Open the Tailscale app, then check again.",
    });
    expect(
      failedCommand(
        failed(
          "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)\n",
        ),
        onLinux,
        linux,
      ).message,
    ).toBe(
      "Tailscale is installed but not running. Start it with sudo systemctl start tailscaled, then check again.",
    );
    expect(
      failedCommand(
        failed(
          "failed to connect to local tailscaled process; is the Tailscale service running?\r\n",
        ),
        onWindows,
        wsl,
      ).message,
    ).toContain("Open Tailscale from the Start menu");
    expect(failedCommand(failed("", { code: null, timedOut: true }), onMac, mac, 10_000)).toEqual({
      state: "unavailable",
      reason: "no-answer",
      message:
        "Tailscale on this Mac didn't answer within 10 seconds. Open the Tailscale app, or quit it and open it again, then check again.",
    });
  });

  it("quotes a short error it doesn't recognise, never a raw dump", () => {
    const running = failedCommand(
      failed(
        "failed to connect to local tailscaled (which appears to be running as /usr/sbin/tailscaled, pid 12). Got error: Access denied\n",
      ),
      onLinux,
      linux,
    );
    expect(running.state).toBe("unavailable");
    expect(running.message).toContain("reported a problem: failed to connect to local tailscaled");
    const noisy = failedCommand(failed(`\u001b[31m${"x".repeat(400)}\n2nd line`), onMac, mac);
    expect(noisy.message).not.toContain("\u001b");
    expect(noisy.message).not.toContain("2nd line");
    expect(noisy.message.length).toBeLessThan(300);
    expect(
      failedCommand(failed("", { code: null, error: "ENOEXEC" }), onWindows, wsl).message,
    ).toContain("Turn WSL interop back on");
  });

  it("reads signed out, expired, off, starting and another account from the backend state", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(backendProblem({ BackendState: "NeedsLogin" }, onMac, now)).toEqual({
      state: "needs-login",
      message: "Tailscale is signed out. Open Tailscale and sign in, then check again.",
    });
    expect(
      backendProblem(
        { BackendState: "NeedsLogin", Self: { KeyExpiry: "2026-10-01T00:00:00Z" } },
        onMac,
        now,
      )?.message,
    ).toBe(
      "Tailscale's sign-in on this Mac has expired. Open Tailscale and sign in, then check again.",
    );
    expect(
      backendProblem(
        { BackendState: "NeedsLogin", Self: { KeyExpiry: "0001-01-01T00:00:00Z" } },
        onLinux,
        now,
      )?.message,
    ).toBe("Tailscale is signed out. Sign in with sudo tailscale up, then check again.");
    expect(backendProblem({ BackendState: "NeedsMachineAuth" }, onMac)?.state).toBe("needs-login");
    expect(backendProblem({ BackendState: "Stopped" }, onMac)).toEqual({
      state: "not-running",
      message: "Tailscale is off. Open Tailscale and connect, then check again.",
    });
    expect(backendProblem({ BackendState: "Starting" }, onMac)?.state).toBe("not-running");
    expect(backendProblem({ BackendState: "InUseOtherUser" }, onWindows)?.reason).toBe(
      "other-user",
    );
    expect(backendProblem(status, onMac)).toBeUndefined();
  });

  it("offers its tailnet address when free, and never takes over a port or a public Funnel", () => {
    expect(serveState(status, null, 4750)).toMatchObject({
      state: "ready-to-enable",
      origin: ORIGIN,
    });
    expect(serveState(status, {}, 443).origin).toBe("https://pc.example.ts.net");
    expect(serveState(status, serve(), 4750)).toMatchObject({ state: "served", origin: ORIGIN });
    expect(
      serveState(status, { ...serve(), AllowFunnel: { "pc.example.ts.net:4750": true } }, 4750),
    ).toMatchObject({ state: "unavailable", reason: "funnel" });
    expect(serveState(status, serve("http://127.0.0.1:3000"), 4750)).toMatchObject({
      state: "unavailable",
      reason: "port-taken",
    });
    expect(serveState({ BackendState: "Running", Self: {} }, null, 4750).reason).toBe("no-name");
  });

  it("finds the page that allows HTTPS, not the tailnet address or a help link", () => {
    expect(
      approvalUrl(
        "\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n1\r\n\n",
      ),
    ).toBe("https://login.tailscale.com/f/serve?node=n1");
    expect(
      approvalUrl(
        "Available within your tailnet:\n\nhttps://pc.example.ts.net:4750/\n|-- proxy http://127.0.0.1:4750\n\nSee https://tailscale.com/kb/1242/tailscale-serve for more.\n",
      ),
    ).toBeUndefined();
  });

  it("asks for operator permission on Linux and keeps an unanswered approval page", () => {
    const denied = failed(
      "Access denied: serve config denied\n\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n",
    );
    expect(enableProblem(denied, onLinux, linux, undefined)).toMatchObject({
      state: "unavailable",
      reason: "permission",
      operatorHint: "sudo tailscale set --operator=$USER",
    });
    expect(enableProblem(denied, onMac, mac, undefined).operatorHint).toBeUndefined();
    const page = "https://login.tailscale.com/f/serve?node=n1";
    expect(enableProblem(failed("", { code: null, timedOut: true }), onMac, mac, page)).toEqual({
      state: "ready-to-enable",
      approvalUrl: page,
      message: "HTTPS wasn't allowed in time. Allow it in Tailscale, then turn on again.",
    });
    expect(enableProblem(failed("certificate error: boom\n"), onMac, mac, undefined)).toEqual({
      state: "unavailable",
      reason: "failed",
      message: "Tailscale couldn't turn on HTTPS for localDot: certificate error: boom.",
    });
  });
});

// A stand-in `tailscale` that answers from files beside it and logs each call. A shell script
// starts in milliseconds, so the waits under test are Tailscale's, not the stand-in's.
const FAKE = `#!/bin/sh
dir=\${0%/*}
echo "$*" >> "$dir/calls.log"
case "$1 $2" in
"status "*) name=status ;;
"serve status") name=serve-status ;;
*) name=serve ;;
esac
if [ "$name" = serve ] && [ -e "$dir/serve.approval" ]; then
  printf '\\nServe is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         %s\\n\\n' "$(cat "$dir/serve.approval")"
  while [ ! -e "$dir/approved" ]; do sleep 0.05; done
fi
[ "$name" != serve ] || [ ! -e "$dir/serve.after" ] || cp "$dir/serve.after" "$dir/serve-status.out"
[ ! -e "$dir/$name.hang" ] || exec sleep 600
[ ! -e "$dir/$name.out" ] || cat "$dir/$name.out"
[ ! -e "$dir/$name.err" ] || cat "$dir/$name.err" >&2
exit "$(cat "$dir/$name.code" 2>/dev/null || echo 0)"
`;
interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}
interface Script {
  status: Reply;
  serveStatus?: Reply;
  serve?: Reply & { approval?: string; after?: Reply };
}
const json = (value: unknown): Reply => ({ stdout: `${JSON.stringify(value)}\n` });
const SERVED = json(serve());
const NOT_RUNNING: Reply = {
  stderr: "failed to connect to local Tailscale service; is Tailscale running?\n",
  code: 1,
};
const APPROVAL = "https://login.tailscale.com/f/serve?node=n1";
const temps: string[] = [];
const opened: AccessLinks[] = [];
afterEach(() => {
  for (const links of opened.splice(0)) links.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-tailscale-"));
  temps.push(dir);
  return dir;
}
function fakeTailscale(script: Script) {
  const dir = temp();
  const write = (name: string, reply: Reply | undefined) => {
    for (const part of ["out", "err", "code", "hang"])
      rmSync(join(dir, `${name}.${part}`), { force: true });
    if (reply?.stdout) writeFileSync(join(dir, `${name}.out`), reply.stdout);
    if (reply?.stderr) writeFileSync(join(dir, `${name}.err`), reply.stderr);
    if (reply?.code) writeFileSync(join(dir, `${name}.code`), String(reply.code));
    if (reply?.hang) writeFileSync(join(dir, `${name}.hang`), "");
  };
  const change = (next: Partial<Script>) => {
    if (next.status) write("status", next.status);
    if (next.serveStatus) write("serve-status", next.serveStatus);
    if (next.serve) {
      write("serve", next.serve);
      for (const part of ["approval", "after"]) rmSync(join(dir, `serve.${part}`), { force: true });
      if (next.serve.approval) writeFileSync(join(dir, "serve.approval"), next.serve.approval);
      if (next.serve.after?.stdout)
        writeFileSync(join(dir, "serve.after"), next.serve.after.stdout);
    }
  };
  change(script);
  const cli = join(dir, "tailscale");
  writeFileSync(cli, FAKE, { mode: 0o755 });
  return {
    cli,
    change,
    calls: () =>
      existsSync(join(dir, "calls.log"))
        ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")
        : [],
    approve: () => writeFileSync(join(dir, "approved"), ""),
  };
}
function accessLinks(
  commands: string[],
  options: { home?: string; readMs?: number; enableMs?: number } = {},
) {
  const links = new AccessLinks(4750, options.home ?? temp(), {
    commands,
    host: linux,
    readMs: options.readMs ?? 10_000,
    enableMs: options.enableMs ?? 10_000,
  });
  opened.push(links);
  return links;
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBe(true);
}

describe("Tailscale through its command line", () => {
  it("reports each state with the next step, and stops waiting on a hung command", {
    timeout: 20_000,
  }, async () => {
    const ready = fakeTailscale({ status: json(status), serveStatus: { stdout: "null\n" } });
    expect((await accessLinks([ready.cli]).read()).tailscale).toMatchObject({
      state: "ready-to-enable",
      origin: ORIGIN,
    });
    expect(ready.calls()).toEqual(["status --json --peers=false", "serve status --json"]);
    const missing = await accessLinks([join(temp(), "tailscale")]).read();
    expect(missing.tailscale.state).toBe("not-installed");
    expect(missing.links.map((link) => link.label)).toEqual(["This computer"]);
    const hung = fakeTailscale({ status: { hang: true }, serveStatus: {} });
    const started = Date.now();
    const answer = await accessLinks([hung.cli], { readMs: 400 }).read();
    expect(answer.tailscale).toMatchObject({ state: "unavailable", reason: "no-answer" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("uses the Tailscale that is connected when two are installed", {
    timeout: 20_000,
  }, async () => {
    const app = fakeTailscale({ status: NOT_RUNNING, serveStatus: {} });
    const brew = fakeTailscale({ status: json(status), serveStatus: SERVED });
    expect((await accessLinks([app.cli, brew.cli]).read()).tailscale).toMatchObject({
      state: "served",
      origin: ORIGIN,
    });
    const signedOut = fakeTailscale({
      status: json({ BackendState: "NeedsLogin" }),
      serveStatus: {},
    });
    expect((await accessLinks([app.cli, signedOut.cli]).read()).tailscale.state).toBe(
      "not-running",
    );
  });

  it("answers with Tailscale's approval page at once, keeps waiting, then serves", {
    timeout: 20_000,
  }, async () => {
    const tailscale = fakeTailscale({
      status: json(status),
      serveStatus: { stdout: "{}\n" },
      serve: {
        approval: APPROVAL,
        stdout: "Success.\nAvailable within your tailnet:\n\nhttps://pc.example.ts.net:4750/\n",
        after: SERVED,
      },
    });
    const home = temp();
    const links = accessLinks([tailscale.cli], { home });
    const [first, again] = await Promise.all([links.enableTailscale(), links.enableTailscale()]);
    expect(first.tailscale).toMatchObject({
      state: "needs-approval",
      approvalUrl: APPROVAL,
      origin: ORIGIN,
    });
    expect(again).toEqual(first);
    expect((await links.read(true)).tailscale.state).toBe("needs-approval");
    expect(isAllowedHost("pc.example.ts.net:4750", 4750)).toBe(false);
    tailscale.approve();
    await eventually(async () => (await links.read(true)).tailscale.state === "served");
    expect(tailscale.calls().filter((call) => call.startsWith("serve --bg"))).toEqual([
      "serve --bg --https=4750 http://127.0.0.1:4750",
    ]);
    expect(isAllowedHost("pc.example.ts.net:4750", 4750)).toBe(true);
    const saved = join(home, "tailscale-serve.json");
    expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual({ origin: ORIGIN });
    expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  it("keeps the approval page after the wait runs out, so turning on again can finish", {
    timeout: 20_000,
  }, async () => {
    const tailscale = fakeTailscale({
      status: json(status),
      serveStatus: { stdout: "null\n" },
      serve: { approval: APPROVAL },
    });
    const links = accessLinks([tailscale.cli], { enableMs: 1_500 });
    expect((await links.enableTailscale()).tailscale.state).toBe("needs-approval");
    await eventually(async () => (await links.read(true)).tailscale.state === "ready-to-enable");
    expect((await links.read()).tailscale).toEqual({
      state: "ready-to-enable",
      origin: ORIGIN,
      approvalUrl: APPROVAL,
      message: "HTTPS wasn't allowed in time. Allow it in Tailscale, then turn on again.",
    });
  });

  it("asks for operator permission on Linux, then lets the user try again", {
    timeout: 20_000,
  }, async () => {
    const tailscale = fakeTailscale({
      status: json(status),
      serveStatus: { stdout: "null\n" },
      serve: {
        stderr:
          "Access denied: serve config denied\n\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n",
        code: 1,
      },
    });
    const links = accessLinks([tailscale.cli]);
    expect((await links.enableTailscale()).tailscale).toMatchObject({
      state: "unavailable",
      reason: "permission",
      operatorHint: "sudo tailscale set --operator=$USER",
    });
    expect((await links.read(true)).tailscale.reason).toBe("permission");
    tailscale.change({ serve: { stdout: "Available within your tailnet:\n", after: SERVED } });
    expect((await links.enableTailscale()).tailscale.state).toBe("served");
  });

  it("lets tailnet devices in from startup, and forgets an address Tailscale no longer serves", {
    timeout: 20_000,
  }, async () => {
    const home = temp();
    const tailscale = fakeTailscale({ status: NOT_RUNNING, serveStatus: {} });
    writeFileSync(join(home, "tailscale-serve.json"), `${JSON.stringify({ origin: ORIGIN })}\n`);
    const links = accessLinks([tailscale.cli], { home });
    expect(isAllowedHost("pc.example.ts.net:4750", 4750)).toBe(true);
    expect((await links.read()).tailscale.state).toBe("not-running");
    expect(isAllowedHost("pc.example.ts.net:4750", 4750)).toBe(true);
    tailscale.change({ status: json(status), serveStatus: { stdout: "null\n" } });
    expect((await links.read(true)).tailscale.state).toBe("ready-to-enable");
    expect(isAllowedHost("pc.example.ts.net:4750", 4750)).toBe(false);
    expect(existsSync(join(home, "tailscale-serve.json"))).toBe(false);
    writeFileSync(join(home, "tailscale-serve.json"), '{"origin":"https://evil.example.com"}\n');
    accessLinks([tailscale.cli], { home });
    expect(isAllowedHost("evil.example.com", 4750)).toBe(false);
  });

  it("looks again once for an unknown tailnet name before refusing it", {
    timeout: 20_000,
  }, async () => {
    const tailscale = fakeTailscale({ status: json(status), serveStatus: SERVED });
    const app = createApp({
      token: "t".repeat(43),
      port: 4750,
      eventLog: {} as EventLog,
      accessLinks: accessLinks([tailscale.cli]),
    });
    expect((await app.request("http://evil.example.com:4750/healthz")).status).toBe(403);
    expect(tailscale.calls()).toEqual([]);
    expect((await app.request(`${ORIGIN}/healthz`)).status).toBe(200);
    expect(tailscale.calls()).toHaveLength(2);
    expect((await app.request("https://other.example.ts.net:4750/healthz")).status).toBe(403);
    expect(tailscale.calls()).toHaveLength(2);
  });
});
