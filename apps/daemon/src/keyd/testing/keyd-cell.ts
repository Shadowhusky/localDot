import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretBinding, sealSecret } from "@localdot/protocol";
import { DockerClient } from "../../cells/docker.ts";
import { imagesFromEnv } from "../../cells/images.ts";
import { CellOrchestrator } from "../../cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "../../cells/readiness.ts";
import { CellStore } from "../../cells/store.ts";

import type { CellRecord } from "../../cells/types.ts";
import { CellKeydWiring } from "../cell-wiring.ts";
import { KeydClient } from "../client.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "./keyd-process.ts";

export const TEST_PREFIX = "localdot-test-";

export interface KeydCell {
  keyd: KeydProcess;
  client: KeydClient;
  wiring: CellKeydWiring;
  orchestrator: CellOrchestrator;
  id: string;
  record: CellRecord;
  // A login shell as the desktop's user, as the agent's terminal runs: the cell's proxy settings
  // and its surrogates (sourced from /etc/localdot/cell/surrogates.sh) are in its environment.
  sh(script: string): { status: number; out: string };
  close(opts?: { artifactsTo?: string }): Promise<void>;
}

// A real keyd (in-memory vault, test ports) holding the given keys, and a ready desktop cell wired
// to it through its gate: the topology of a real install.
export async function startKeydCell(
  secrets: { binding: SecretBinding; value: string }[] = [],
): Promise<KeydCell> {
  const keyd = await startKeyd();
  const home = mkdtempSync(join(tmpdir(), "local dot's keyd-cell-"));
  const client = new KeydClient(keyd.socketPath);
  const docker = new DockerClient();
  const wiring = new CellKeydWiring({ keyd: client, docker });
  const store = new CellStore(home, TEST_KEYD_PORTS);
  const orchestrator = new CellOrchestrator({
    docker,
    store,
    images: imagesFromEnv(),
    probeDesktopd,
    probeStream,
    namePrefix: TEST_PREFIX,
    keyd: wiring,
  });
  let id: string | undefined;
  let closing: Promise<void> | undefined;
  const close = (opts: { artifactsTo?: string } = {}) => {
    if (closing) return closing;
    closing = (async () => {
      orchestrator.dispose();
      const errors: unknown[] = [];
      for (const owned of new Set([...(id ? [id] : []), ...store.list().map((r) => r.id)])) {
        try {
          await orchestrator.remove(owned, { purgeHome: true });
        } catch (error) {
          errors.push(error);
        }
      }
      await keyd.stop(opts);
      if (errors.length)
        throw new AggregateError(errors, `test cleanup failed; retained state at ${home}`);
      rmSync(home, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    const { sealKey } = await client.status();
    for (const { binding, value } of secrets) {
      await client.putSecret(binding, await sealSecret(sealKey, binding, value));
    }
    const created = await orchestrator.create({ scale: 2 });
    id = created.id;
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("test cell readiness timed out")), 180_000);
      const settle = (state: string | undefined, error?: string) => {
        if (state === "ready") finish();
        if (state === "failed") finish(new Error(`the cell failed: ${error}`));
      };
      unsubscribe = orchestrator.subscribe((c) => c.id === created.id && settle(c.state, c.error));
      const now = orchestrator.get(created.id);
      settle(now?.state, now?.error);
    });
    const record = orchestrator.record(created.id);
    if (!record) throw new Error("the cell has no record");
    const sh = (script: string) => {
      const result = spawnSync(
        "docker",
        ["exec", "-u", "abc", record.docker.desktop, "bash", "-lc", script],
        {
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return {
        status: result.status ?? -1,
        out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
      };
    };
    return { keyd, client, wiring, orchestrator, id: created.id, record, sh, close };
  } catch (err) {
    await close();
    throw err;
  }
}

// keyd's audit lines about one cell, parsed.
export function auditLines(keyd: KeydProcess, cellId?: string): Record<string, unknown>[] {
  return readFileSync(join(keyd.home, "keyd", "audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => cellId === undefined || line.cell === cellId);
}
