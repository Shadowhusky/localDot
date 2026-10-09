import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApprovalAnswer, type ApprovalCard, ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionApprovals } from "../agent/safety/connections.ts";
import { RulesStore } from "../agent/safety/rules.ts";
import { AgentSession } from "../agent/session.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { LiveSessions } from "../gateway/live.ts";
import { CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient } from "../keyd/client.ts";
import { KeydEventRouter } from "../keyd/event-router.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "../keyd/testing/keyd-process.ts";
import { DockerClient } from "./docker.ts";
import { imagesFromEnv } from "./images.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { probeDesktopd, probeStream } from "./readiness.ts";
import { cellNames } from "./spec.ts";
import { CellStore } from "./store.ts";
import { DOCKER_TESTS, removeAll } from "./testing/docker-cli.ts";

// A desktop app that ignores the proxy, end to end: the desktop's TCP crosses its link to the
// gate, which hands it to keyd by name. Websites work; another port waits for the card and is
// remembered; SMTP, the Mac, local networks and metadata are refused without a card. It reaches
// example.com and portquiz.net, so it is opt-in twice: LOCALDOT_DOCKER_TESTS=1 and
// LOCALDOT_CAPTURE_TESTS=1, with LOCALDOT_DESKTOP_IMAGE and LOCALDOT_GATE_IMAGE built from this tree.
const ENABLED = DOCKER_TESTS && process.env.LOCALDOT_CAPTURE_TESTS === "1";
const PREFIX = process.env.LOCALDOT_CAPTURE_TEST_PREFIX || "ldtest-capture-";
const [LABEL_KEY = "", LABEL_VALUE = ""] = (
  process.env.LOCALDOT_CAPTURE_TEST_LABEL || "dev.localdot.test=capture"
).split("=");

interface Run {
  status: number;
  out: string;
  ms: number;
}

describe.skipIf(!ENABLED)("a desktop app that ignores the proxy", () => {
  let home = "";
  let keyd: KeydProcess;
  let orchestrator: CellOrchestrator;
  let store: CellStore;
  let rules: RulesStore;
  let router: KeydEventRouter;
  let cellId = "";
  let desktop = "";
  const cards: ApprovalCard[] = [];
  // How the stand-in user answers each card, by port.
  const answers = new Map<number, Omit<ApprovalAnswer, "approvalId" | "generation" | "revision">>();

  // Asynchronous, so the card flow below keeps running while a program waits on it.
  const run = (...cmd: string[]) =>
    new Promise<Run>((resolve) => {
      const started = Date.now();
      execFile("docker", ["exec", "-u", "abc", desktop, ...cmd], (error, stdout, stderr) =>
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          out: `${stdout}${stderr}`,
          ms: Date.now() - started,
        }),
      );
    });
  const curl = (...args: string[]) =>
    run("curl", "--noproxy", "*", "-sS", "-o", "/dev/null", "-w", "%{http_code}", ...args);
  const audit = () =>
    readFileSync(join(dirname(keyd.socketPath), "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ld-capture-"));
    keyd = await startKeyd();
    const keydClient = new KeydClient(keyd.socketPath);
    const client = new DockerClient();
    store = new CellStore(home, TEST_KEYD_PORTS);
    orchestrator = new CellOrchestrator({
      docker: client,
      keyd: new CellKeydWiring({ keyd: keydClient, docker: client }),
      store,
      images: imagesFromEnv(),
      probeDesktopd,
      probeStream,
      namePrefix: PREFIX,
      labels: { [LABEL_KEY]: LABEL_VALUE },
    });
    const created = await orchestrator.create({ scale: 1 });
    cellId = created.id;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const cell = orchestrator.list().find((c) => c.id === cellId);
        if (cell?.state === "ready") resolve();
        else if (cell?.state === "failed") reject(new Error(cell.error));
        else return false;
        return true;
      };
      if (check()) return;
      const stop = orchestrator.subscribe(() => {
        if (check()) stop();
      });
    });
    desktop = store.get(cellId)?.docker.desktop ?? "";
    rules = new RulesStore(home);
    // The running task, as the daemon has it: its cards and the rules a yes saves.
    const session: AgentSession = new AgentSession(
      ulid(),
      cellId,
      "Message Henry on the chat app",
      {
        append: (_id, event) => {
          const { type, data } = event as { type: string; data: Record<string, unknown> };
          if (type !== "approval.request" || data.actionClass !== "network")
            return undefined as never;
          const {
            preview,
            kind: _kind,
            ...card
          } = data as Record<string, unknown> & {
            preview: { fields: ApprovalCard["fields"] };
          };
          const shown = { ...card, fields: preview.fields } as unknown as ApprovalCard;
          cards.push(shown);
          const port = Number(shown.always?.[0]?.destination?.split(":").at(-1));
          const answer = answers.get(port) ?? { decision: "deny" as const };
          setTimeout(() =>
            session.connections.answer({
              approvalId: shown.approvalId,
              generation: shown.generation,
              revision: shown.revision,
              ...answer,
            }),
          );
          return undefined as never;
        },
      },
      undefined,
      rules,
    );
    const approvals = new ConnectionApprovals({
      keyd: keydClient,
      task: () => session,
      rules,
      owner: async (_cell, port) => {
        const endpoint = orchestrator.endpoints(cellId)?.desktopd;
        return endpoint ? new DesktopdClient(endpoint).connectionOwner(port) : undefined;
      },
      cells: () => [cellId],
    });
    router = new KeydEventRouter({
      keyd: keydClient,
      live: new LiveSessions(),
      eventLog: { append: () => undefined as never },
      ask: (cell, held) => void approvals.ask(cell, held),
    });
    router.start();
  }, 300_000);

  afterAll(async () => {
    router?.stop();
    orchestrator?.dispose();
    if (cellId) {
      await orchestrator.remove(cellId, { purgeHome: true }).catch(() => {});
      const n = cellNames(cellId, PREFIX);
      removeAll({
        containers: [n.desktop, n.gate],
        networks: [n.internalNetwork, n.egressNetwork],
        volumes: [n.homeVolume],
      });
    }
    if (home) rmSync(home, { recursive: true, force: true });
    await keyd?.stop();
  }, 120_000);

  it("resolves names to the gate's placeholders and reaches websites by name and by address", async () => {
    expect((await run("getent", "hosts", "example.com")).out).toMatch(
      /^198\.1[89]\.\d+\.\d+\s+example\.com/,
    );
    expect((await curl("-m", "30", "https://example.com/")).out).toBe("200");
    expect((await curl("-m", "30", "http://example.com/")).out).toBe("200");
    // Straight to an address, as apps with their own DNS do: the gate asks by the TLS name.
    const { address } = await lookup("example.com", { family: 4 });
    const direct = await curl(
      "-m",
      "30",
      "--connect-to",
      `example.com:443:${address}:443`,
      "https://example.com/",
    );
    expect(direct.out).toBe("200");
    // An app's own protocol to an address on a web port, naming nothing, as WeChat's long link.
    const opaque = await run(
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${address}/80 && printf '\\x16\\xf1\\x04 binary\\r\\n\\r\\n' >&3 && timeout 15 head -c 5 <&3`,
    );
    expect(opaque.out).toBe("HTTP/");
    expect(cards).toEqual([]);
    const captured = audit().filter((l) => l.via === "capture" && l.host === "example.com");
    expect(captured.map((l) => l.decision)).toEqual(["allow", "allow", "allow"]);
    expect(audit().filter((l) => l.via === "capture" && l.host === address)).toMatchObject([
      { decision: "allow", destPort: 80, mode: "tunnel" },
    ]);
  });

  it("holds another port for the card, lets it through on a yes and remembers Always", async () => {
    answers.set(8080, { decision: "approve", always: "destination" });
    expect((await curl("-m", "60", "http://portquiz.net:8080/")).out).toBe("200");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      actionClass: "network",
      title: "curl wants to connect to portquiz.net on port 8080",
    });
    expect(rules.list().rules).toMatchObject([
      { scope: "destination", destination: "portquiz.net:8080", app: "curl" },
    ]);
    answers.delete(8080);
    expect((await curl("-m", "60", "http://portquiz.net:8080/")).out).toBe("200");
    expect(cards).toHaveLength(1);
    // A no keeps the app out.
    const refused = await curl("-m", "60", "http://portquiz.net:8081/");
    expect(refused.status).not.toBe(0);
    expect(cards.map((card) => card.title)).toEqual([
      "curl wants to connect to portquiz.net on port 8080",
      "curl wants to connect to portquiz.net on port 8081",
    ]);
  });

  it("refuses SMTP, the Mac, local networks and metadata at once, without a card", async () => {
    for (const target of [
      "telnet://portquiz.net:25",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.1.2.3:8080/",
      "http://192.168.65.254:4750/",
      "http://host.docker.internal:4750/",
    ]) {
      const r = await curl("-m", "20", target);
      expect(r.status, `${target}: ${r.out}`).not.toBe(0);
      expect(r.ms, target).toBeLessThan(10_000);
    }
    expect(cards).toHaveLength(2);
    const refused = audit().filter((l) => l.via === "capture" && l.decision === "deny");
    expect(refused.map((l) => l.reason)).toEqual(
      expect.arrayContaining(["smtp-blocked", "address-denied"]),
    );
  });

  it("keeps the proxy for the apps that use it", async () => {
    const proxied = await run(
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-m",
      "30",
      "https://example.com/",
    );
    expect(proxied.out).toBe("200");
  });
});
