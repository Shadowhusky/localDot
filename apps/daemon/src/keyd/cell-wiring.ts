import { SECRET_ID_PATTERN, SURROGATE_PATTERN, surrogateEnvName } from "@localdot/protocol";
import type { DockerClient } from "../cells/docker.ts";
import { type TarFile, tar } from "../cells/tar.ts";
import type { CellRecord } from "../cells/types.ts";
import { type KeydClient, KeydError, KeydUnavailableError } from "./client.ts";

// Where a desktop cell finds what keyd gave it (the image creates the directory; its boot oneshot
// installs the CA, the forwarder reads the token, login and interactive shells source the
// surrogates). These are cell-scoped credentials and a public CA; provider keys stay in keyd.
export const CELL_FILES_DIR = "/etc/localdot/cell";

// keyd is part of a cell's start: a cell without its listener has no egress and fails its boot
// self-test, so the orchestrator never starts one without it.
export interface CellKeyd {
  // Opens the cell in keyd afresh (a new token, CA and surrogates) and writes them into the
  // desktop container, which must not be running: its CA is installed at boot.
  wire(record: CellRecord): Promise<void>;
  // Whether keyd still has the cell open on its port (false after a keyd restart).
  isWired(record: CellRecord): Promise<boolean>;
  // Fresh surrogates for a running desktop (after the kill switch, or after a key changed); returns
  // the web keys keyd would not mint because the cell's CA does not cover their hosts.
  refresh(record: CellRecord): Promise<string[]>;
  revoke(cellId: string): Promise<number>;
  close(cellId: string): Promise<void>;
}

export class KeyLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyLayerError";
  }
}

export class CellKeydWiring implements CellKeyd {
  constructor(private readonly deps: { keyd: KeydClient; docker: DockerClient }) {}

  async wire(record: CellRecord): Promise<void> {
    await guard(async () => {
      const { keyd } = this.deps;
      const container = await this.deps.docker.request<{ State: { Running: boolean } }>({
        method: "GET",
        path: `/containers/${encodeURIComponent(record.docker.desktop)}/json`,
      });
      if (container.State.Running !== false)
        throw new KeyLayerError("stop the computer before replacing its key material");
      const secrets = await this.#webSecrets();
      await keyd.closeCell(record.id);
      try {
        const opened = await keyd.openCell({
          cellId: record.id,
          role: "desktop",
          port: record.keydPort,
          secrets,
        });
        if (opened.cellId !== record.id || opened.port !== record.keydPort)
          throw new KeyLayerError("keyd opened a different cell or listener");
        const surrogates = opened.surrogates ?? {};
        requireSurrogates(surrogates, secrets);
        await this.#write(record, [
          { name: "proxy-token", data: `${opened.proxyToken}\n` },
          { name: "ca.pem", data: opened.caCertPem },
          { name: "surrogates.sh", data: surrogatesFile(surrogates) },
        ]);
      } catch (err) {
        // Even a lost open reply may have allocated a listener. Do not strand it after an upload
        // failure, or while unwinding a failed create. Keep the original failure as the reason.
        await keyd.closeCell(record.id).catch(() => {});
        throw err;
      }
    });
  }

  async isWired(record: CellRecord): Promise<boolean> {
    return guard(async () => {
      const cell = await this.deps.keyd.cell(record.id);
      return cell?.cellId === record.id && cell.port === record.keydPort && cell.role === "desktop";
    });
  }

  // keyd mints all-or-nothing, so each key is asked for alone: a key bound to a host outside the
  // cell's CA (added after the cell opened) waits for the next start without holding up the rest.
  async refresh(record: CellRecord): Promise<string[]> {
    const skipped: string[] = [];
    await guard(async () => {
      const surrogates: Record<string, string> = {};
      for (const id of await this.#webSecrets()) {
        try {
          const minted = await this.deps.keyd.mint(record.id, [id]);
          requireSurrogates(minted, [id]);
          Object.assign(surrogates, minted);
        } catch (err) {
          if (!(err instanceof KeydError) || err.status !== 400) throw err;
          skipped.push(id);
        }
      }
      await this.#write(record, [{ name: "surrogates.sh", data: surrogatesFile(surrogates) }]);
    }).catch(async (err: unknown) => {
      // A partial mint or upload must not leave new, undisclosed credentials active.
      await this.revoke(record.id).catch(() => {});
      throw err;
    });
    return skipped;
  }

  // A cell keyd no longer knows (it restarted) has nothing left to revoke.
  async revoke(cellId: string): Promise<number> {
    try {
      return await this.deps.keyd.revoke(cellId);
    } catch (err) {
      if (err instanceof KeydError && err.status === 404) return 0;
      throw err;
    }
  }

  async close(cellId: string): Promise<void> {
    await this.deps.keyd.closeCell(cellId);
  }

  async #webSecrets(): Promise<string[]> {
    return (await this.deps.keyd.secrets()).filter((s) => s.kind === "http").map((s) => s.id);
  }

  async #write(record: CellRecord, files: TarFile[]): Promise<void> {
    await this.deps.docker.putArchive(record.docker.desktop, CELL_FILES_DIR, tar(files));
  }
}

// One `export NAME='surrogate'` line per web API key; ids and surrogates are checked again here
// because this text is sourced by a shell.
export function surrogatesFile(surrogates: Record<string, string>): string {
  const names = new Set<string>();
  const lines = Object.entries(surrogates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      if (!SECRET_ID_PATTERN.test(id) || !SURROGATE_PATTERN.test(value)) {
        throw new KeyLayerError("keyd returned a malformed surrogate");
      }
      const name = surrogateEnvName(id);
      if (names.has(name)) throw new KeyLayerError("keyd returned colliding surrogate names");
      names.add(name);
      return `export ${name}='${value}'`;
    });
  return [
    "# Surrogates for this computer's web API keys: they work only through keyd.",
    ...lines,
    "",
  ].join("\n");
}

function requireSurrogates(surrogates: Record<string, string>, expected: string[]): void {
  const ids = Object.keys(surrogates);
  if (ids.length !== expected.length || expected.some((id) => !Object.hasOwn(surrogates, id)))
    throw new KeyLayerError("keyd returned surrogates for unexpected keys");
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof KeydUnavailableError) {
      throw new KeyLayerError(
        "the key layer is offline: start keyd, then start the computer again",
      );
    }
    throw err;
  }
}
