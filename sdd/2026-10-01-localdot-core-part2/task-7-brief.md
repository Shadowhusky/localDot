### Task 7: Cell records, per-cell tokens, stream tickets and keyd ports

**Files:**
- Create: `apps/daemon/src/cells/types.ts`, `apps/daemon/src/cells/store.ts`,
  `apps/daemon/src/cells/secrets.ts`, `apps/daemon/src/cells/ports.ts`,
  `apps/daemon/src/cells/testing/sample-record.ts`
- Test: `apps/daemon/src/cells/store.test.ts`, `apps/daemon/src/cells/secrets.test.ts`,
  `apps/daemon/src/cells/ports.test.ts`

**Interfaces:**
- Produces (`types.ts`): `Scale = 1 | 2`; `CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed"`;
  `StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected"`;
  `StreamState { connection; viewers: number; lastUpstreamAt: number | null }`, `NO_STREAM`;
  `CellSummary { id; state; scale; createdAt; stream: StreamState; error?: string }`;
  `CellRecord { v: 1; id; createdAt; scale; keydPort; tokens: { desktopd; stream }; docker: CellDocker }`;
  `CellDocker { internalNetwork; egressNetwork; homeVolume; gate; desktop; gateInternalIp; gateEgressIp; desktopIp }`;
  `DesktopdEndpoint { baseUrl; token }`, `StreamEndpoint { baseUrl; authorization }`,
  `CellEndpoints { desktopd; stream }`; `DesktopdHealth` (the shape Task 5 serves).
- `class CellStore { constructor(home); list(): CellRecord[]; get(id): CellRecord | undefined; save(record); remove(id) }`
  — files `<home>/cells/<id>/cell.json`, 0600, written atomically.
- `newCellToken(): string` (43 chars base64url); `TICKET_PATTERN`;
  `class TicketRegistry { issue(cellId): string (returns the cell's live ticket while one exists); resolve(ticket): string | undefined (constant-time); revoke(cellId): void }`.
- `KEYD_PORT_RANGE = { from: 4760, to: 4789 }`; `allocateKeydPort(inUse: Iterable<number>): number`.

- [ ] **Step 1: Write the types**

`apps/daemon/src/cells/types.ts`:
```ts
export type Scale = 1 | 2;

export type CellState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "removed";

export type StreamConnection = "none" | "connecting" | "live" | "stalled" | "disconnected";

export interface StreamState {
  connection: StreamConnection;
  viewers: number;
  lastUpstreamAt: number | null;
}

export const NO_STREAM: StreamState = { connection: "none", viewers: 0, lastUpstreamAt: null };

export interface CellSummary {
  id: string;
  state: CellState;
  scale: Scale;
  createdAt: string;
  stream: StreamState;
  error?: string;
}

export interface CellDocker {
  internalNetwork: string;
  egressNetwork: string;
  homeVolume: string;
  gate: string;
  desktop: string;
  gateInternalIp: string;
  gateEgressIp: string;
  desktopIp: string;
}

export interface CellRecord {
  v: 1;
  id: string;
  createdAt: string;
  scale: Scale;
  keydPort: number;
  tokens: { desktopd: string; stream: string };
  docker: CellDocker;
}

export interface DesktopdEndpoint {
  baseUrl: string;
  token: string;
}

export interface StreamEndpoint {
  baseUrl: string;
  authorization: string;
}

export interface CellEndpoints {
  desktopd: DesktopdEndpoint;
  stream: StreamEndpoint;
}

// What desktopd's GET /healthz returns (cells/desktop/desktopd/src/app.ts).
export interface DesktopdHealth {
  ok: boolean;
  scale: Scale;
  display: string;
  screen: { w: number; h: number } | null;
  hidpi: {
    ok: boolean;
    expected: { windowScalingFactor: Scale; xftDpi: 96 };
    windowScalingFactor: number | null;
    xftDpi: number | null;
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/cells/testing/sample-record.ts` (a test helper shared by the store, spec and
orchestrator tests; it lives outside the `*.test.ts` files so importing it never re-registers tests):
```ts
import { ulid } from "@localdot/protocol";
import type { CellRecord } from "../types.ts";

export function sampleRecord(id = ulid(), createdAt = "2026-10-01T10:00:00.000Z"): CellRecord {
  return {
    v: 1,
    id,
    createdAt,
    scale: 2,
    keydPort: 4760,
    tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
    docker: {
      internalNetwork: `localdot-cell-${id}`,
      egressNetwork: `localdot-egress-${id}`,
      homeVolume: `localdot-home-${id}`,
      gate: `localdot-gate-${id}`,
      desktop: `localdot-desktop-${id}`,
      gateInternalIp: "172.24.0.10",
      gateEgressIp: "172.25.0.10",
      desktopIp: "172.24.0.11",
    },
  };
}
```

`apps/daemon/src/cells/store.test.ts`:
```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const home = () => mkdtempSync(join(tmpdir(), "local dot's cells-"));

describe("CellStore", () => {
  it("round-trips a record through a 0600 file in a 0700 directory", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    const file = join(dir, "cells", record.id, "cell.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cells")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(store.get(record.id)).toEqual(record);
  });

  it("lists records oldest first and skips ids that are not ULIDs or files that are not records", () => {
    const dir = home();
    const store = new CellStore(dir);
    const older = sampleRecord(ulid(), "2026-10-01T09:00:00.000Z");
    const newer = sampleRecord(ulid(), "2026-10-01T11:00:00.000Z");
    store.save(newer);
    store.save(older);
    const bad = sampleRecord();
    store.save(bad);
    writeFileSync(join(dir, "cells", bad.id, "cell.json"), "{not json");
    expect(store.list().map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(store.get("../etc")).toBeUndefined();
    expect(store.get(bad.id)).toBeUndefined();
  });

  it("removes a cell directory and refuses invalid ids", () => {
    const store = new CellStore(home());
    const record = sampleRecord();
    store.save(record);
    store.remove(record.id);
    expect(store.get(record.id)).toBeUndefined();
    expect(() => store.remove("../..")).toThrow("invalid cell id");
  });
});
```

`apps/daemon/src/cells/secrets.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newCellToken, TICKET_PATTERN, TicketRegistry } from "./secrets.ts";

describe("cell secrets", () => {
  it("mints 43-character base64url tokens that differ", () => {
    const a = newCellToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCellToken()).not.toBe(a);
  });

  it("keeps one live ticket per cell, resolves it, and revokes per cell", () => {
    const tickets = new TicketRegistry();
    const t1 = tickets.issue("cell-a");
    const t2 = tickets.issue("cell-b");
    expect(t1).toMatch(TICKET_PATTERN);
    expect(tickets.issue("cell-a")).toBe(t1);
    expect(tickets.resolve(t1)).toBe("cell-a");
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.resolve("nope")).toBeUndefined();
    expect(tickets.resolve(`${t1}x`)).toBeUndefined();
    const flipped = `${t1.slice(0, 21)}${t1.endsWith("A") ? "B" : "A"}`;
    expect(tickets.resolve(flipped)).toBeUndefined();
    tickets.revoke("cell-a");
    expect(tickets.resolve(t1)).toBeUndefined();
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.issue("cell-a")).not.toBe(t1);
  });
});
```

`apps/daemon/src/cells/ports.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { allocateKeydPort, KEYD_PORT_RANGE } from "./ports.ts";

describe("allocateKeydPort", () => {
  it("hands out the lowest free listener port in 4760-4789", () => {
    expect(allocateKeydPort([])).toBe(4760);
    expect(allocateKeydPort([4760, 4761])).toBe(4762);
    expect(allocateKeydPort([4760, 4762])).toBe(4761);
  });

  it("fails when the range is exhausted", () => {
    const all: number[] = [];
    for (let p = KEYD_PORT_RANGE.from; p <= KEYD_PORT_RANGE.to; p++) all.push(p);
    expect(() => allocateKeydPort(all)).toThrow("no free keyd listener port");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/cells/store.test.ts apps/daemon/src/cells/secrets.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: FAIL — three `Failed to load url` errors.

- [ ] **Step 4: Implement the three modules**

`apps/daemon/src/cells/store.ts`:
```ts
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import type { CellRecord } from "./types.ts";

// One cell.json per cell under <home>/cells/<id>/, mode 0600: it holds the per-cell tokens.
export class CellStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "cells");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  list(): CellRecord[] {
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ULID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const record = this.get(entry.name);
        return record ? [record] : [];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): CellRecord | undefined {
    if (!ULID_PATTERN.test(id)) return undefined;
    let text: string;
    try {
      text = readFileSync(this.#file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const record = JSON.parse(text) as CellRecord;
      return record.v === 1 && record.id === id ? record : undefined;
    } catch (err) {
      console.error(`cell ${id}: unreadable record: ${String(err)}`);
      return undefined;
    }
  }

  save(record: CellRecord): void {
    mkdirSync(join(this.#root, record.id), { recursive: true, mode: 0o700 });
    const file = this.#file(record.id);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  remove(id: string): void {
    if (!ULID_PATTERN.test(id)) throw new Error("invalid cell id");
    rmSync(join(this.#root, id), { recursive: true, force: true });
  }

  #file(id: string): string {
    return join(this.#root, id, "cell.json");
  }
}
```

`apps/daemon/src/cells/secrets.ts`:
```ts
import { randomBytes, timingSafeEqual } from "node:crypto";

export function newCellToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// A stream ticket lets the Selkies iframe, which can carry no Authorization header, open one
// cell's stream path (P2-R2): one live ticket per cell, 128 random bits, kept in memory only (a
// daemon restart revokes every ticket), compared in constant time, never logged. The ticket itself
// is kept so the API can hand the same one back while the cell stays ready.
export class TicketRegistry {
  readonly #byCell = new Map<string, string>();

  issue(cellId: string): string {
    const live = this.#byCell.get(cellId);
    if (live !== undefined) return live;
    const ticket = randomBytes(16).toString("base64url");
    this.#byCell.set(cellId, ticket);
    return ticket;
  }

  resolve(ticket: string): string | undefined {
    if (!TICKET_PATTERN.test(ticket)) return undefined;
    const given = Buffer.from(ticket);
    for (const [cellId, live] of this.#byCell) {
      if (timingSafeEqual(given, Buffer.from(live))) return cellId;
    }
    return undefined;
  }

  revoke(cellId: string): void {
    this.#byCell.delete(cellId);
  }
}
```

`apps/daemon/src/cells/ports.ts`:
```ts
export const KEYD_PORT_RANGE = { from: 4760, to: 4789 } as const;

// Each cell gets its own keyd listener port; the gate relays to it and keyd knows the cell by it.
export function allocateKeydPort(inUse: Iterable<number>): number {
  const used = new Set(inUse);
  for (let port = KEYD_PORT_RANGE.from; port <= KEYD_PORT_RANGE.to; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free keyd listener port in ${KEYD_PORT_RANGE.from}-${KEYD_PORT_RANGE.to}`);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/store.test.ts apps/daemon/src/cells/secrets.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/cells
git commit -m "feat(daemon): cell records, per-cell tokens, tickets and keyd ports"
```

---
