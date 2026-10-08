import { randomUUID } from "node:crypto";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import type { ComputerResetSource } from "../../../../packages/protocol/src/computer-reset.ts";
import {
  type BrowserKeydClient,
  closeBrowserKeyd,
  openBrowserKeyd,
} from "../keyd/browser-wiring.ts";
import { readBrowserHealth, validateBrowserHealth } from "./browser-health.ts";
import { type BrowserLedger, BrowserLedgerStore, BrowserLifecycleError } from "./browser-ledger.ts";
import {
  browserLabels,
  browserObjectPath,
  inspectBrowserResources,
  requireDetachedProfile,
  requireFreshBrowserNames,
  retireBrowserResources,
} from "./browser-resources.ts";
import {
  browserNames,
  browserNetworkSpec,
  browserSpec,
  profileVolumeSpec,
} from "./browser-spec.ts";
import type { DockerClient } from "./docker.ts";
import type { BrowserImages } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { allocateKeydPort } from "./ports.ts";
import { captureComputerResetSource } from "./reset-source.ts";
import { newCellToken } from "./secrets.ts";
import {
  DESKTOP_OFFSET,
  GATE_OFFSET,
  GATE_PORTS,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  NAME_PREFIX,
} from "./spec.ts";
import { sendContainerInput } from "./stdin.ts";
import type { CellStore } from "./store.ts";
import type { BrowserCellRecord, CellState } from "./types.ts";

type Docker = Pick<DockerClient, "request" | "socketPath">;
type Raw = Record<string, unknown>;
const raw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const dockerId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new BrowserLifecycleError();
  return value;
};

export interface ReadyBrowser {
  browserCellId: string;
  parentCellId: string;
  instance: string;
  browserd: { baseUrl: string; token: string };
  stream: { baseUrl: string; authorization: string };
}

export interface BrowserOrchestratorDeps {
  home: string;
  store: CellStore;
  docker: Docker;
  keyd: BrowserKeydClient;
  images: BrowserImages;
  parentAvailable(parentCellId: string): boolean;
  externalKeydPorts?(): Iterable<number>;
  namePrefix?: string;
  readyTimeoutMs?: number;
  probe?: typeof readBrowserHealth;
  sendInput?: typeof sendContainerInput;
}

export class BrowserOrchestrator {
  readonly #ledger: BrowserLedgerStore;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #epochs = new Map<string, number>();
  readonly #starting = new Map<string, AbortController>();
  readonly #ready = new Map<string, ReadyBrowser>();
  readonly #state = new Map<string, CellState>();
  readonly #listeners = new Set<(parentCellId: string) => void>();

  subscribe(listener: (parentCellId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(parentCellId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(parentCellId);
      } catch {
        /* Observers cannot delay containment. */
      }
    }
  }

  constructor(private readonly deps: BrowserOrchestratorDeps) {
    this.#ledger = new BrowserLedgerStore(deps.home, deps.store.keydPorts);
  }

  reservedKeydPorts(): number[] {
    const inventory = this.deps.store.inventoryAll();
    if (inventory.skipped.length) throw new BrowserLifecycleError("Cell port ownership is unknown");
    return [
      ...new Set([
        ...inventory.records.map((record) => record.keydPort),
        ...this.#ledger
          .list()
          .filter((record) => record.phase !== "retained")
          .map((record) => record.keydPort),
      ]),
    ];
  }

  get(parentCellId: string): { id: string; parentCellId: string; state: CellState } | undefined {
    const record = this.#ledger.forParent(parentCellId);
    return record
      ? {
          id: record.id,
          parentCellId,
          state:
            this.#state.get(parentCellId) ??
            (record.phase === "stopped" || record.phase === "retained" ? "stopped" : "failed"),
        }
      : undefined;
  }

  endpoints(parentCellId: string): ReadyBrowser | undefined {
    const ready = this.#ready.get(parentCellId);
    if (!ready || !this.deps.parentAvailable(parentCellId) || !this.deps.store.get(parentCellId))
      return undefined;
    return structuredClone(ready);
  }

  start(parentCellId: string, signal = new AbortController().signal): Promise<ReadyBrowser> {
    if (!ULID_PATTERN.test(parentCellId)) return Promise.reject(new BrowserLifecycleError());
    const epoch = this.#epochs.get(parentCellId) ?? 0;
    return this.#queued(parentCellId, () => this.#start(parentCellId, epoch, signal));
  }

  stop(parentCellId: string): Promise<void> {
    this.#fence(parentCellId);
    return this.#queued(parentCellId, async () => {
      const record = this.#ledger.forParent(parentCellId);
      if (record) await this.#contain(record);
      else if (this.deps.store.browserFor(parentCellId))
        throw new BrowserLifecycleError("Browser recovery ownership is missing");
      this.#state.set(parentCellId, "stopped");
    });
  }

  remove(parentCellId: string, options: { purgeProfile?: boolean } = {}): Promise<void> {
    this.#fence(parentCellId);
    return this.#queued(parentCellId, async () => {
      const record = this.#ledger.forParent(parentCellId);
      if (!record) {
        if (this.deps.store.browserFor(parentCellId))
          throw new BrowserLifecycleError("Browser recovery ownership is missing");
        return;
      }
      await this.#contain(record, options.purgeProfile === true);
      this.#association(record);
      this.deps.store.remove(record.id);
      if (options.purgeProfile) this.#ledger.remove(record);
      else {
        record.phase = "retained";
        this.#ledger.save(record);
      }
      this.#state.set(parentCellId, "removed");
    });
  }

  resetSource(parent: string): ComputerResetSource["browser"] {
    const record = this.#ledger.forParent(parent);
    if (!record) {
      if (this.deps.store.browserFor(parent))
        throw new BrowserLifecycleError("Browser reset ownership is missing");
      return null;
    }
    this.#association(record);
    const desktop = this.deps.store.get(parent);
    if (!desktop) throw new BrowserLifecycleError("Reset desktop record is missing");
    return captureComputerResetSource(desktop, record).browser;
  }

  resetRetired(parent: string, source: ComputerResetSource["browser"]): boolean {
    return (
      !this.#ledger.forParent(parent) &&
      !this.deps.store.browserFor(parent) &&
      (!source ||
        (!this.deps.store.getStored(source.id) &&
          !this.deps.store.inventoryAll().skipped.includes(source.id)))
    );
  }

  retireReset(
    parent: string,
    source: ComputerResetSource["browser"],
    retire: () => Promise<void>,
  ): Promise<void> {
    this.#fence(parent);
    return this.#queued(parent, async () => {
      if (this.deps.parentAvailable(parent))
        throw new BrowserLifecycleError("Reset parent admission is not held");
      const record = this.#ledger.forParent(parent);
      if (record) {
        if (
          !source ||
          record.id !== source.id ||
          record.owner !== source.owner ||
          browserNames(record.id, record.prefix).profileVolume !== source.resources.volume
        )
          throw new BrowserLifecycleError("Browser reset ownership changed");
        this.#association(record);
        await closeBrowserKeyd(this.deps.keyd, record);
      } else {
        if (
          !this.resetRetired(parent, source) ||
          (source && (await this.deps.keyd.cell(source.id)))
        )
          throw new BrowserLifecycleError("Browser reset retirement is unconfirmed");
      }
      await retire();
      if (record) {
        if ((await inspectBrowserResources(this.deps.docker, record)).length)
          throw new BrowserLifecycleError();
        await requireDetachedProfile(this.deps.docker, record);
        if (await this.deps.keyd.cell(record.id)) throw new BrowserLifecycleError();
        this.#association(record);
        this.deps.store.remove(record.id);
        this.#ledger.remove(record);
      }
      this.#state.set(parent, "removed");
    });
  }

  async reconcile(): Promise<void> {
    // Recovery discovery may fail. Revoke every current or queued owner before
    // consulting disk so an unrelated damaged record cannot preserve authority.
    const current = new Set([
      ...this.#ready.keys(),
      ...this.#starting.keys(),
      ...this.#queues.keys(),
      ...this.#state.keys(),
    ]);
    for (const parent of current) this.#fence(parent);
    const records = this.#ledger.list();
    for (const record of records) this.#fence(record.parentCellId);
    const inventory = this.deps.store.inventoryAll();
    const unknown =
      inventory.skipped.length > 0 ||
      inventory.records.some(
        (record) =>
          record.kind === "browser" &&
          !records.some(
            (owner) => owner.id === record.id && owner.parentCellId === record.parentCellId,
          ),
      );
    const result = await Promise.allSettled(
      records.map((record) => this.stop(record.parentCellId)),
    );
    if (unknown || result.some((entry) => entry.status === "rejected"))
      throw new BrowserLifecycleError("Browser recovery needs attention");
  }

  #fence(parent: string): void {
    if (!ULID_PATTERN.test(parent)) throw new BrowserLifecycleError();
    this.#epochs.set(parent, (this.#epochs.get(parent) ?? 0) + 1);
    this.#ready.delete(parent);
    this.#state.set(parent, "stopping");
    this.#starting.get(parent)?.abort();
    this.#changed(parent);
  }

  #queued<T>(parent: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(parent) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#queues.set(parent, next);
    void next
      .finally(() => {
        if (this.#queues.get(parent) === next) this.#queues.delete(parent);
      })
      .catch(() => {});
    return next;
  }

  #check(parent: string, epoch: number, signal: AbortSignal): void {
    if (
      signal.aborted ||
      (this.#epochs.get(parent) ?? 0) !== epoch ||
      !this.deps.parentAvailable(parent) ||
      !this.deps.store.get(parent)
    )
      throw new BrowserLifecycleError("Browser start was cancelled");
  }

  #allocate(parent: string): BrowserLedger {
    const desktop = this.deps.store.get(parent);
    if (!desktop || this.deps.store.browserFor(parent))
      throw new BrowserLifecycleError("Browser association needs recovery");
    const record: BrowserLedger = {
      v: 1,
      id: ulid(),
      parentCellId: parent,
      owner: randomUUID(),
      prefix: this.deps.namePrefix ?? NAME_PREFIX,
      createdAt: new Date().toISOString(),
      scale: desktop.scale,
      phase: "provisioning",
      resources: {},
      keydPort: allocateKeydPort(
        [...this.reservedKeydPorts(), ...(this.deps.externalKeydPorts?.() ?? [])],
        this.deps.store.keydPorts,
      ),
      tokens: { browserd: newCellToken(), stream: newCellToken() },
    };
    if (this.deps.store.getStored(record.id) || this.#ledger.get(record.id))
      throw new BrowserLifecycleError();
    this.#ledger.save(record);
    return record;
  }

  #association(record: BrowserLedger): void {
    const stored = this.deps.store.getStored(record.id);
    if (
      (stored &&
        (stored.kind !== "browser" ||
          stored.parentCellId !== record.parentCellId ||
          stored.docker.profileVolume !== browserNames(record.id, record.prefix).profileVolume)) ||
      this.deps.store.inventoryAll().skipped.includes(record.id)
    )
      throw new BrowserLifecycleError("Browser record ownership changed");
  }

  async #contain(record: BrowserLedger, purge = false): Promise<void> {
    this.#ready.delete(record.parentCellId);
    this.#changed(record.parentCellId);
    const results = await Promise.allSettled([
      closeBrowserKeyd(this.deps.keyd, record),
      retireBrowserResources(this.deps.docker, record, purge),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      record.phase = "failed";
      this.#state.set(record.parentCellId, "failed");
      this.#ledger.save(record);
      throw new BrowserLifecycleError("Browser shutdown could not be confirmed; retry Stop");
    }
    record.resources = {};
    if (record.phase !== "retained") record.phase = "stopped";
    this.#ledger.save(record);
  }

  async #start(parent: string, epoch: number, caller: AbortSignal): Promise<ReadyBrowser> {
    this.#check(parent, epoch, caller);
    const current = this.endpoints(parent);
    if (current) return current;
    const cancel = new AbortController();
    this.#starting.set(parent, cancel);
    const timeout = AbortSignal.timeout(this.deps.readyTimeoutMs ?? 90000);
    const signal = AbortSignal.any([caller, cancel.signal, timeout]);
    const check = () => this.#check(parent, epoch, signal);
    let record: BrowserLedger | undefined;
    let material: Buffer | undefined;
    let stage = "ownership recovery";
    this.#state.set(parent, "starting");
    try {
      record = this.#ledger.forParent(parent);
      if (record) {
        this.#association(record);
        await this.#contain(record);
      } else {
        record = this.#allocate(parent);
        await requireFreshBrowserNames(this.deps.docker, record);
      }
      check();
      if (record.phase === "retained")
        record.keydPort = allocateKeydPort(
          [...this.reservedKeydPorts(), ...(this.deps.externalKeydPorts?.() ?? [])],
          this.deps.store.keydPorts,
        );
      record.phase = "provisioning";
      record.tokens = { browserd: newCellToken(), stream: newCellToken() };
      this.#ledger.save(record);
      const names = browserNames(record.id, record.prefix);
      stage = "profile attachment";
      await requireDetachedProfile(this.deps.docker, record);
      check();
      const profile = (await inspectBrowserResources(this.deps.docker, record)).find(
        (entry) => entry.kind === "volumes",
      );
      check();
      if (!profile) {
        await this.deps.docker.request({
          method: "POST",
          path: "/volumes/create",
          body: {
            ...profileVolumeSpec(names.profileVolume, record.id, parent),
            Labels: browserLabels(record, "profile"),
          },
        });
        check();
        if (
          !(await inspectBrowserResources(this.deps.docker, record)).some(
            (entry) => entry.kind === "volumes",
          )
        )
          throw new BrowserLifecycleError();
        check();
      }
      const subnets: string[] = [];
      stage = "network creation";
      for (const [kind, field] of [
        ["internal", "internalNetwork"],
        ["egress", "egressNetwork"],
      ] as const) {
        check();
        const created = await this.deps.docker.request<{ Id?: unknown }>({
          method: "POST",
          path: "/networks/create",
          body: {
            ...browserNetworkSpec(kind, names[field], record.id, parent),
            Labels: browserLabels(record, kind),
          },
        });
        record.resources[field] = dockerId(created?.Id);
        this.#ledger.save(record);
        check();
        const network = (await inspectBrowserResources(this.deps.docker, record)).find(
          (entry) => entry.field === field,
        )?.raw;
        check();
        subnets.push(this.#subnet(network, kind));
      }
      const [internal, egress] = subnets as [string, string];
      if (hostAddress(internal, GATE_OFFSET) === hostAddress(egress, GATE_OFFSET))
        throw new BrowserLifecycleError();
      const cell: BrowserCellRecord = {
        v: 2,
        kind: "browser",
        id: record.id,
        parentCellId: parent,
        createdAt: record.createdAt,
        scale: record.scale,
        keydPort: record.keydPort,
        tokens: { ...record.tokens },
        docker: {
          ...names,
          gateInternalIp: hostAddress(internal, GATE_OFFSET),
          gateEgressIp: hostAddress(egress, GATE_OFFSET),
          browserIp: hostAddress(internal, DESKTOP_OFFSET),
        },
      };
      this.deps.store.saveBrowser(cell);
      stage = "container creation";
      for (const [field, spec] of [
        ["gate", gateSpec(cell, this.deps.images.gate)],
        ["browser", browserSpec(cell, this.deps.images.browser)],
      ] as const) {
        check();
        const created = await this.deps.docker.request<{ Id?: unknown }>({
          method: "POST",
          path: "/containers/create",
          query: { name: names[field] },
          body: {
            ...spec,
            Labels: browserLabels(record, field),
            ...(field === "browser" ? { Hostname: `browser-${record.id.toLowerCase()}` } : {}),
          },
        });
        record.resources[field] = dockerId(created?.Id);
        this.#ledger.save(record);
        check();
      }
      const { gate, browser, internalNetwork, egressNetwork } = record.resources;
      if (!gate || !browser || !internalNetwork || !egressNetwork)
        throw new BrowserLifecycleError();
      cell.ownership = { gate, browser, internalNetwork, egressNetwork };
      this.deps.store.saveBrowser(cell);
      const resources = await inspectBrowserResources(this.deps.docker, record);
      check();
      if (resources.length !== 5) throw new BrowserLifecycleError();
      stage = "key listener creation";
      material = await openBrowserKeyd(this.deps.keyd, record, signal);
      check();
      stage = "container startup";
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("containers", gate, "start"),
      });
      check();
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("networks", internalNetwork, "connect"),
        body: {
          Container: gate,
          EndpointConfig: { IPAMConfig: { IPv4Address: cell.docker.gateInternalIp } },
        },
      });
      check();
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("containers", browser, "start"),
      });
      check();
      stage = "private bootstrap";
      await (this.deps.sendInput ?? sendContainerInput)(
        this.deps.docker,
        browser,
        material,
        signal,
      );
      material.fill(0);
      material = undefined;
      check();
      stage = "network verification";
      const inspected = await inspectBrowserResources(this.deps.docker, record);
      check();
      const gateInfo = inspected.find((entry) => entry.field === "gate")?.raw;
      const browserInfo = inspected.find((entry) => entry.field === "browser")?.raw;
      this.#networks(gateInfo, {
        [names.internalNetwork]: [internalNetwork, cell.docker.gateInternalIp],
        [names.egressNetwork]: [egressNetwork, cell.docker.gateEgressIp],
      });
      this.#networks(browserInfo, {
        [names.internalNetwork]: [internalNetwork, cell.docker.browserIp],
      });
      const ports = this.#ports(gateInfo);
      stage = "readiness";
      let instance: string;
      for (;;) {
        check();
        let value: unknown;
        try {
          value = await (this.deps.probe ?? readBrowserHealth)(
            ports.service,
            cell.tokens.browserd,
            signal,
          );
        } catch {
          check();
          const running = (await inspectBrowserResources(this.deps.docker, record)).find(
            (entry) => entry.field === "browser",
          )?.raw.State;
          check();
          if (!raw(running) || running.Running !== true)
            throw new BrowserLifecycleError("Browser process exited during startup");
          await this.#wait(signal);
          continue;
        }
        check();
        const health = validateBrowserHealth(value, cell, record.lastInstance);
        if (health.ready) {
          instance = health.instance;
          break;
        }
        await this.#wait(signal);
      }
      check();
      record.lastInstance = instance;
      record.phase = "active";
      this.#association(record);
      const stored = this.deps.store.getBrowser(record.id);
      if (
        !stored ||
        stored.tokens.browserd !== cell.tokens.browserd ||
        stored.tokens.stream !== cell.tokens.stream ||
        stored.ownership?.browser !== browser ||
        stored.ownership?.gate !== gate
      )
        throw new BrowserLifecycleError();
      this.#ledger.save(record);
      check();
      const ready: ReadyBrowser = {
        browserCellId: record.id,
        parentCellId: parent,
        instance,
        browserd: { baseUrl: `http://127.0.0.1:${ports.service}`, token: cell.tokens.browserd },
        stream: {
          baseUrl: `http://127.0.0.1:${ports.stream}`,
          authorization: `Basic ${Buffer.from(`localdot:${cell.tokens.stream}`).toString("base64")}`,
        },
      };
      this.#ready.set(parent, ready);
      this.#state.set(parent, "ready");
      this.#changed(parent);
      return structuredClone(ready);
    } catch {
      this.#ready.delete(parent);
      if (record) {
        try {
          await this.#contain(record);
        } catch {}
        record.phase = "failed";
        try {
          this.#ledger.save(record);
        } catch {}
      }
      this.#state.set(parent, "failed");
      throw new BrowserLifecycleError(
        `Browser start failed during ${stage}; its profile has been retained`,
      );
    } finally {
      material?.fill(0);
      if (this.#starting.get(parent) === cancel) this.#starting.delete(parent);
    }
  }

  #subnet(network: Raw | undefined, kind: "internal" | "egress"): string {
    const ipam = network && raw(network.IPAM) ? network.IPAM : undefined;
    const configs = ipam?.Config;
    const options = network && raw(network.Options) ? network.Options : undefined;
    if (
      network?.Driver !== "bridge" ||
      network.EnableIPv6 !== false ||
      network.Internal !== (kind === "internal") ||
      !Array.isArray(configs) ||
      configs.length !== 1 ||
      !raw(configs[0]) ||
      typeof configs[0].Subnet !== "string" ||
      (kind === "internal" &&
        (configs[0].Gateway || options?.[ISOLATED_GATEWAY_OPTION] !== "isolated"))
    )
      throw new BrowserLifecycleError("Browser network isolation could not be confirmed");
    const subnet = configs[0].Subnet;
    const address = hostAddress(subnet, GATE_OFFSET);
    if (!/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/u.test(address))
      throw new BrowserLifecycleError();
    return subnet;
  }

  #networks(value: Raw | undefined, expected: Record<string, [string, string]>): void {
    const state = value && raw(value.State) ? value.State : undefined;
    const settings = value && raw(value.NetworkSettings) ? value.NetworkSettings : undefined;
    const networks = settings?.Networks;
    if (
      state?.Running !== true ||
      state.Paused !== false ||
      !raw(networks) ||
      Object.keys(networks).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, [id, address]]) => {
        const info = networks[name];
        return (
          !raw(info) ||
          info.NetworkID !== id ||
          info.IPAddress !== address ||
          Boolean(info.GlobalIPv6Address)
        );
      })
    )
      throw new BrowserLifecycleError("Browser network attachment is invalid");
  }

  #ports(value: Raw | undefined): { service: number; stream: number } {
    const settings = value && raw(value.NetworkSettings) ? value.NetworkSettings : undefined;
    const ports = settings?.Ports;
    if (
      !raw(ports) ||
      Object.keys(ports).some((key) => key !== GATE_PORTS.desktopd && key !== GATE_PORTS.stream)
    )
      throw new BrowserLifecycleError("Browser gate has unexpected published ports");
    const port = (key: string) => {
      const bindings = raw(ports) ? ports[key] : undefined;
      if (
        !Array.isArray(bindings) ||
        bindings.length !== 1 ||
        !raw(bindings[0]) ||
        bindings[0].HostIp !== "127.0.0.1" ||
        typeof bindings[0].HostPort !== "string" ||
        !/^[0-9]{4,5}$/u.test(bindings[0].HostPort)
      )
        throw new BrowserLifecycleError("Browser gate is not loopback-only");
      const number = Number(bindings[0].HostPort);
      if (number < 1024 || number > 65535) throw new BrowserLifecycleError();
      return number;
    };
    const service = port(GATE_PORTS.desktopd),
      stream = port(GATE_PORTS.stream);
    if (service === stream) throw new BrowserLifecycleError();
    return { service, stream };
  }

  #wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new BrowserLifecycleError());
      };
      const timer = setTimeout(end, 100);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
