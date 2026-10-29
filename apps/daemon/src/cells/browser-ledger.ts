import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { browserNames } from "./browser-spec.ts";
import type { PortRange } from "./ports.ts";

const id = z.string().regex(ULID_PATTERN);
const dockerId = z.string().regex(/^[a-f0-9]{64}$/u);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const schema = z.strictObject({
  v: z.literal(1),
  id,
  parentCellId: id,
  owner: z.string().uuid(),
  prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*-$/u),
  createdAt: z.string().datetime(),
  scale: z.union([z.literal(1), z.literal(2)]),
  keydPort: z.number().int().min(1024).max(65535),
  tokens: z.strictObject({ browserd: token, stream: token }),
  phase: z.enum(["provisioning", "active", "stopped", "failed", "retained"]),
  resources: z.strictObject({
    internalNetwork: dockerId.optional(),
    egressNetwork: dockerId.optional(),
    gate: dockerId.optional(),
    browser: dockerId.optional(),
  }),
  lastInstance: z.string().uuid().optional(),
});

export type BrowserLedger = z.infer<typeof schema>;
export class BrowserLifecycleError extends Error {
  constructor(message = "Browser lifecycle could not be confirmed") {
    super(message);
    this.name = "BrowserLifecycleError";
  }
}

// A start given up because its computer, keyd or a newer stop or start took the browser over: not a
// failure of the browser itself.
export class BrowserStartCancelled extends BrowserLifecycleError {
  constructor() {
    super("Browser start was cancelled");
    this.name = "BrowserStartCancelled";
  }
}

export class BrowserLedgerStore {
  readonly #root: string;
  constructor(
    home: string,
    readonly ports: PortRange,
  ) {
    this.#root = join(home, "browser-owners");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    chmodSync(this.#root, 0o700);
  }

  #decode(value: unknown, expected: string): BrowserLedger {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BrowserLifecycleError("Browser recovery record is invalid");
    const record = parsed.data;
    if (
      record.id !== expected ||
      record.id === record.parentCellId ||
      record.tokens.browserd === record.tokens.stream ||
      record.keydPort < this.ports.from ||
      record.keydPort > this.ports.to
    )
      throw new BrowserLifecycleError("Browser recovery record is invalid");
    browserNames(record.id, record.prefix);
    return record;
  }

  #path(value: string): string {
    if (!ULID_PATTERN.test(value)) throw new BrowserLifecycleError();
    return join(this.#root, `${value}.json`);
  }

  get(value: string): BrowserLedger | undefined {
    let text: string;
    try {
      text = readFileSync(this.#path(value), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new BrowserLifecycleError("Browser recovery record is unreadable");
    }
    try {
      return this.#decode(JSON.parse(text), value);
    } catch {
      throw new BrowserLifecycleError("Browser recovery record is invalid");
    }
  }

  list(): BrowserLedger[] {
    const result: BrowserLedger[] = [];
    for (const name of readdirSync(this.#root)) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -5));
      if (!record) throw new BrowserLifecycleError();
      result.push(record);
    }
    const parents = new Set<string>();
    for (const record of result) {
      if (parents.has(record.parentCellId))
        throw new BrowserLifecycleError("Browser recovery association is ambiguous");
      parents.add(record.parentCellId);
    }
    return result;
  }

  forParent(parent: string): BrowserLedger | undefined {
    if (!ULID_PATTERN.test(parent)) throw new BrowserLifecycleError();
    return this.list().find((record) => record.parentCellId === parent);
  }

  save(value: BrowserLedger): void {
    const record = this.#decode(value, value.id);
    const previous = this.get(record.id);
    const parent = this.forParent(record.parentCellId);
    if (
      (parent && parent.id !== record.id) ||
      (previous &&
        (previous.parentCellId !== record.parentCellId ||
          previous.owner !== record.owner ||
          previous.prefix !== record.prefix ||
          previous.createdAt !== record.createdAt))
    )
      throw new BrowserLifecycleError("Browser recovery ownership changed");
    const path = this.#path(record.id);
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  remove(record: BrowserLedger): void {
    const previous = this.get(record.id);
    if (
      !previous ||
      previous.owner !== record.owner ||
      previous.parentCellId !== record.parentCellId
    )
      throw new BrowserLifecycleError();
    rmSync(this.#path(record.id));
  }
}
