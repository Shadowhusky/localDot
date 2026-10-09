import { isIP } from "node:net";
import { posix } from "node:path";
import { z as schema } from "zod";
import { safeDownloadName } from "../../../../packages/protocol/src/quarantine.ts";

const empty = schema.strictObject({});
const identifier = schema.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const nodeId = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const target = schema.strictObject({ targetId: identifier });
const backendNode = schema.strictObject({ backendNodeId: nodeId });
const filter = schema.tuple([
  schema.strictObject({ type: schema.literal("page"), exclude: schema.literal(false) }),
  schema.strictObject({ type: schema.literal("iframe"), exclude: schema.literal(false) }),
  schema.strictObject({ exclude: schema.literal(true) }),
]);

const cookieText = schema.string().max(4096);
const commands = Object.freeze({
  "Storage.getCookies": empty,
  "Network.deleteCookies": schema.strictObject({
    name: cookieText,
    domain: schema.string().min(1).max(256),
    path: cookieText,
  }),
  "Storage.clearDataForOrigin": schema.strictObject({
    origin: schema.string().min(1).max(270),
    storageTypes: schema.literal("all"),
  }),
  "DOMSnapshot.captureSnapshot": schema.strictObject({
    computedStyles: schema.array(schema.never()).length(0),
  }),
  "Browser.getVersion": empty,
  "Browser.setDownloadBehavior": schema.union([
    schema.strictObject({
      behavior: schema.literal("allowAndName"),
      downloadPath: schema.string().min(1).max(256),
      eventsEnabled: schema.literal(true),
    }),
    schema.strictObject({ behavior: schema.literal("deny"), eventsEnabled: schema.literal(true) }),
  ]),
  "Browser.cancelDownload": schema.strictObject({ guid: schema.uuid() }),
  "Browser.getWindowForTarget": target,
  "Browser.setWindowBounds": schema.strictObject({
    windowId: nodeId,
    bounds: schema.strictObject({ windowState: schema.literal("maximized") }),
  }),
  "Target.setDiscoverTargets": schema.strictObject({ discover: schema.literal(true), filter }),
  "Target.setAutoAttach": schema.strictObject({
    autoAttach: schema.literal(true),
    waitForDebuggerOnStart: schema.literal(true),
    flatten: schema.literal(true),
    filter,
  }),
  "Target.getTargets": schema.strictObject({ filter }),
  "Target.attachToTarget": schema.strictObject({
    targetId: identifier,
    flatten: schema.literal(true),
  }),
  "Target.detachFromTarget": schema.strictObject({ sessionId: identifier }),
  "Target.createTarget": schema.strictObject({ url: schema.literal("about:blank") }),
  "Target.activateTarget": target,
  "Runtime.runIfWaitingForDebugger": empty,
  "Page.enable": empty,
  "Page.setLifecycleEventsEnabled": schema.strictObject({ enabled: schema.literal(true) }),
  "Page.navigate": schema.strictObject({ url: schema.string().min(1).max(2048) }),
  "Page.reload": schema.strictObject({ ignoreCache: schema.boolean().optional() }),
  "Page.stopLoading": empty,
  "Page.getLayoutMetrics": empty,
  "Page.getFrameTree": empty,
  "Page.bringToFront": empty,
  "Page.setInterceptFileChooserDialog": schema.strictObject({ enabled: schema.literal(true) }),
  "Page.handleJavaScriptDialog": schema.strictObject({ accept: schema.boolean() }),
  "DOM.enable": empty,
  "DOM.getDocument": schema.strictObject({
    depth: schema.literal(1),
    pierce: schema.literal(false).optional(),
  }),
  "DOM.getNodeForLocation": schema.strictObject({
    x: schema.number().int().min(0).max(0x7fffffff),
    y: schema.number().int().min(0).max(0x7fffffff),
    includeUserAgentShadowDOM: schema.literal(false).optional(),
    ignorePointerEventsNone: schema.literal(false).optional(),
  }),
  "DOM.getBoxModel": backendNode,
  "DOM.describeNode": schema.strictObject({
    backendNodeId: nodeId,
    depth: schema.literal(0).optional(),
    pierce: schema.literal(false).optional(),
  }),
  "DOM.setFileInputFiles": schema.strictObject({
    files: schema.array(schema.string().min(1).max(512)).min(1).max(10),
    backendNodeId: nodeId,
  }),
  "Accessibility.enable": empty,
  "Accessibility.getFullAXTree": schema.strictObject({
    depth: schema.number().int().positive().max(64).optional(),
  }),
  "Accessibility.getPartialAXTree": schema.strictObject({
    backendNodeId: nodeId,
    fetchRelatives: schema.literal(false),
  }),
});

type CommandName = keyof typeof commands;

export interface CdpCapabilities {
  readonly downloadDir: string;
  readonly uploadDir: string;
  ownsTarget(targetId: string): boolean;
  ownsSession(sessionId: string): boolean;
  ownsWindow(windowId: number): boolean;
  ownsNode(sessionId: string, backendNodeId: number): boolean;
  ownsDownload(guid: string): boolean;
  allowsUpload(sessionId: string, backendNodeId: number, files: readonly string[]): boolean;
}

export interface GuardedCdpCommand {
  readonly method: CommandName;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export class CdpRefused extends Error {
  constructor(readonly reason: "method" | "params" | "scope" | "url" | "upload" | "download") {
    super(`Browser command refused: ${reason}`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function navigable(raw: unknown): boolean {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 2048 ||
    /\s/u.test(raw) ||
    containsControlCharacter(raw)
  )
    return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    return false;
  const host = parsed.hostname.replace(/\.$/u, "").toLowerCase();
  return (
    host.length <= 253 &&
    host.includes(".") &&
    isIP(host) === 0 &&
    !host.includes(":") &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

function privateDirectory(directory: string): boolean {
  return (
    posix.isAbsolute(directory) &&
    directory !== "/" &&
    posix.normalize(directory) === directory &&
    !directory.endsWith("/") &&
    !containsControlCharacter(directory)
  );
}

function frozenParams(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested)
        if (item && typeof item === "object") frozenParams(item as Record<string, unknown>);
      Object.freeze(nested);
    } else if (nested && typeof nested === "object")
      frozenParams(nested as Record<string, unknown>);
  }
  return Object.freeze(value);
}

export function guardCdpCommand(
  method: string,
  rawParams: unknown,
  capabilities: CdpCapabilities,
  sessionId?: string,
): GuardedCdpCommand {
  if (!Object.hasOwn(commands, method)) throw new CdpRefused("method");
  const name = method as CommandName;
  const parsed = commands[name].safeParse(rawParams);
  if (!parsed.success) throw new CdpRefused("params");
  const params = frozenParams(parsed.data as Record<string, unknown>);
  const pageCommand =
    /^(Page|DOM|DOMSnapshot|Accessibility|Runtime|Network)\./u.test(name) ||
    name === "Storage.clearDataForOrigin";
  if (pageCommand || (name === "Target.setAutoAttach" && sessionId !== undefined)) {
    if (
      !sessionId ||
      !identifier.safeParse(sessionId).success ||
      !capabilities.ownsSession(sessionId)
    )
      throw new CdpRefused("scope");
  } else if (sessionId !== undefined) throw new CdpRefused("scope");

  if (typeof params.targetId === "string" && !capabilities.ownsTarget(params.targetId))
    throw new CdpRefused("scope");
  if (typeof params.sessionId === "string" && !capabilities.ownsSession(params.sessionId))
    throw new CdpRefused("scope");
  if (typeof params.windowId === "number" && !capabilities.ownsWindow(params.windowId))
    throw new CdpRefused("scope");
  if (
    typeof params.backendNodeId === "number" &&
    (!sessionId || !capabilities.ownsNode(sessionId, params.backendNodeId))
  )
    throw new CdpRefused("scope");
  if (name === "Page.navigate" && !navigable(params.url)) throw new CdpRefused("url");
  if (name === "Storage.clearDataForOrigin") {
    const origin = String(params.origin);
    const scheme = /^https?:\/\//u.exec(origin)?.[0];
    if (!scheme || !navigable(`${origin}/`) || new URL(origin).origin !== origin)
      throw new CdpRefused("url");
  }
  if (name === "Browser.cancelDownload" && !capabilities.ownsDownload(params.guid as string))
    throw new CdpRefused("download");
  if (
    name === "Browser.setDownloadBehavior" &&
    params.behavior === "allowAndName" &&
    (!privateDirectory(capabilities.downloadDir) ||
      params.downloadPath !== capabilities.downloadDir)
  )
    throw new CdpRefused("download");
  if (name === "DOM.setFileInputFiles") {
    const files = params.files as readonly string[];
    if (
      !privateDirectory(capabilities.uploadDir) ||
      new Set(files).size !== files.length ||
      files.some(
        (file) =>
          !file.startsWith(`${capabilities.uploadDir}/`) ||
          (posix.dirname(file) !== capabilities.uploadDir &&
            !(
              posix.dirname(posix.dirname(file)) === capabilities.uploadDir &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                posix.basename(posix.dirname(file)),
              ) &&
              posix.basename(file) === safeDownloadName(posix.basename(file))
            )) ||
          posix.normalize(file) !== file ||
          containsControlCharacter(file),
      ) ||
      !sessionId ||
      !capabilities.allowsUpload(sessionId, params.backendNodeId as number, files)
    )
      throw new CdpRefused("upload");
  }
  return Object.freeze({
    method: name,
    params: frozenParams(params),
    ...(sessionId ? { sessionId } : {}),
  });
}
