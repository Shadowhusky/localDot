import { randomBytes } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
import { isIP } from "node:net";
import { isDeepStrictEqual as equal } from "node:util";
import { DOCKER_API, dockerSocketPath } from "./cells/docker.ts";
import { ISOLATED_GATEWAY_OPTION, isolatedNetworkSpec } from "./cells/spec.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const fullId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const failure = () => new Error("The owned gateway probe could not be verified.");
const LABEL = "localdot.doctor-probe";

function transport(socket: string) {
  return async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: object,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const active = new AbortController(),
      abort = () => active.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 10_000);
    let req: ReturnType<typeof request> | undefined,
      res: IncomingMessage | undefined,
      closed: Promise<void> | undefined;
    let result: unknown;
    try {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      res = await new Promise<IncomingMessage>((resolve, reject) => {
        req = request(
          {
            socketPath: socket,
            path: `/${DOCKER_API}${path}`,
            method,
            agent: false,
            signal: active.signal,
            headers: {
              host: "docker",
              accept: "application/json",
              "accept-encoding": "identity",
              "content-length": String(payload?.length ?? 0),
              ...(payload ? { "content-type": "application/json" } : {}),
            },
          },
          resolve,
        );
        closed = new Promise<void>((done) => req?.once("close", done));
        req.once("error", reject);
        req.end(payload);
      });
      const length = res.headers["content-length"];
      if (
        (res.headers["content-encoding"] !== undefined &&
          res.headers["content-encoding"] !== "identity") ||
        (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 1024 * 1024))
      )
        throw failure();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res) {
        active.signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) throw failure();
        chunks.push(bytes);
      }
      active.signal.throwIfAborted();
      if (!res.complete || (length !== undefined && Number(length) !== size)) throw failure();
      if ((method === "GET" || method === "DELETE") && res.statusCode === 404) result = null;
      else if (method === "DELETE") {
        if (res.statusCode !== 204 || size !== 0) throw failure();
        result = null;
      } else {
        if (
          res.statusCode !== (method === "POST" ? 201 : 200) ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers["content-type"] ?? "")
        )
          throw failure();
        result = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (!object(result)) throw failure();
      }
    } finally {
      res?.destroy();
      req?.destroy();
      await closed;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    active.signal.throwIfAborted();
    return result;
  };
}

function isolation(info: Record<string, unknown>) {
  if (
    !object(info.IPAM) ||
    !Array.isArray(info.IPAM.Config) ||
    info.IPAM.Config.length !== 1 ||
    !object(info.IPAM.Config[0]) ||
    typeof info.IPAM.Config[0].Subnet !== "string"
  )
    return { ok: false, detail: "The engine created the probe network with no IPv4 subnet." };
  const config = info.IPAM.Config[0],
    [ip = "", bits = ""] = String(config.Subnet).split("/");
  if (
    isIP(ip) !== 4 ||
    !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(bits) ||
    String(config.Subnet) !== `${ip}/${bits}`
  )
    return { ok: false, detail: "The engine returned an invalid IPv4 subnet for its probe." };
  if (info.Internal !== true)
    return { ok: false, detail: "The engine made the probe network, but not internal." };
  if (
    info.EnableIPv6 !== false ||
    !object(info.Options) ||
    info.Options[ISOLATED_GATEWAY_OPTION] !== "isolated" ||
    (config.Gateway !== undefined && config.Gateway !== "" && config.Gateway !== "invalid IP")
  )
    return {
      ok: false,
      detail: "The engine still assigns a gateway or ignores isolated internal-network options.",
    };
  return {
    ok: true,
    detail: "Internal networks get no gateway address; owned probe cleanup is confirmed.",
  };
}

/** Development-only ephemeral probe. Its random label proves only this invocation's
 * ownership. No prefix/age sweep, listing, deletion by name, or recovery of older
 * runs. A crash can leave an empty labeled network; installed doctor has a separate
 * durable journal for recovery. Full request closure precedes every next effect. */
export async function runDoctorNetworkProbe(
  socketInput: string,
  requestedName?: string,
  callerSignal?: AbortSignal,
) {
  const nonce = randomBytes(16).toString("hex"),
    name = requestedName ?? `localdot-doctor-probe-${nonce}`;
  let verdict = { ok: false, detail: "The owned gateway probe could not be verified." };
  if (!/^localdot-(?:doctor-probe|test)-[A-Za-z0-9_-]{1,128}$/.test(name)) return verdict;
  let socket: string;
  try {
    socket = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  } catch {
    return verdict;
  }
  const exchange = transport(socket),
    active = new AbortController(),
    abort = () => active.abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(abort, 60_000);
  let expectedEngine: { id: string; os: string; architecture: string } | undefined,
    acknowledged: string | undefined,
    attempted = false,
    cleanupFailed = false;
  async function engine(signal: AbortSignal) {
    const value = await exchange("GET", "/info", signal);
    if (
      !object(value) ||
      typeof value.ID !== "string" ||
      !/^[A-Za-z0-9_:-]{1,256}$/.test(value.ID) ||
      value.OSType !== "linux" ||
      typeof value.Architecture !== "string" ||
      !["arm64", "aarch64", "amd64", "x86_64"].includes(value.Architecture)
    )
      throw failure();
    const current = { id: value.ID, os: value.OSType, architecture: value.Architecture };
    if (expectedEngine && !equal(current, expectedEngine)) throw failure();
    return current;
  }
  const inspect = (reference: string, signal: AbortSignal) =>
    exchange("GET", `/networks/${reference}`, signal);
  function owned(raw: unknown, expected?: string) {
    if (
      !object(raw) ||
      !fullId(raw.Id) ||
      (expected !== undefined && raw.Id !== expected) ||
      raw.Name !== name ||
      raw.Driver !== "bridge" ||
      !object(raw.Labels) ||
      Object.keys(raw.Labels).length !== 1 ||
      raw.Labels[LABEL] !== nonce ||
      !object(raw.Containers) ||
      Object.keys(raw.Containers).length !== 0
    )
      throw failure();
    return raw as Record<string, unknown> & { Id: string };
  }
  async function cleanup(signal: AbortSignal) {
    await engine(signal);
    const named = await inspect(name, signal);
    if (named !== null) {
      const first = owned(named, acknowledged),
        current = await inspect(first.Id, signal);
      if (current !== null) {
        owned(current, first.Id);
        await engine(signal);
        try {
          await exchange("DELETE", `/networks/${first.Id}`, signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      if ((await inspect(first.Id, signal)) !== null) throw failure();
    } else if (acknowledged && (await inspect(acknowledged, signal)) !== null) throw failure();
    if ((await inspect(name, signal)) !== null) throw failure();
    await engine(signal);
    signal.throwIfAborted();
  }
  try {
    expectedEngine = await engine(active.signal);
    if ((await inspect(name, active.signal)) !== null) throw failure();
    await engine(active.signal);
    active.signal.throwIfAborted();
    attempted = true;
    const created = await exchange("POST", "/networks/create", active.signal, {
      ...isolatedNetworkSpec(name),
      CheckDuplicate: true,
      Labels: { [LABEL]: nonce },
    });
    if (!object(created) || !fullId(created.Id)) throw failure();
    acknowledged = created.Id;
    const first = owned(await inspect(acknowledged, active.signal), acknowledged);
    verdict = isolation(first);
    await engine(active.signal);
    const final = owned(await inspect(name, active.signal), acknowledged);
    if (!equal(isolation(final), verdict)) throw failure();
    active.signal.throwIfAborted();
  } catch {
    verdict = { ok: false, detail: "The owned gateway probe could not be verified." };
  } finally {
    if (attempted) {
      const retiring = new AbortController(),
        deadline = setTimeout(() => retiring.abort(), 30_000);
      try {
        await cleanup(retiring.signal);
      } catch {
        cleanupFailed = true;
        verdict = {
          ok: false,
          detail:
            "Diagnostic network cleanup could not be confirmed. Check Docker Desktop; no other network was removed.",
        };
      } finally {
        clearTimeout(deadline);
      }
    }
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
  if (active.signal.aborted && !cleanupFailed)
    return {
      ok: false,
      detail: "Gateway diagnostics interrupted; owned probe cleanup was awaited.",
    };
  return verdict;
}
