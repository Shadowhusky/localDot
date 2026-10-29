import { request } from "node:http";
import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import {
  BrowserSignInState,
  type BrowserSupervisorState,
} from "../../../../packages/protocol/src/browser-control.ts";
import { BrowserLifecycleError } from "./browser-ledger.ts";
import type { BrowserCellRecord } from "./types.ts";

const healthSchema = z.strictObject({
  browserCellId: z.string().regex(ULID_PATTERN),
  parentCellId: z.string().regex(ULID_PATTERN),
  instance: z.string().uuid(),
  ready: z.boolean(),
  holder: z.enum(["user", "agent"]),
  signIn: BrowserSignInState.optional(),
  width: z.literal(1280),
  height: z.literal(800),
});
export type BrowserHealth = z.infer<typeof healthSchema>;

export function validateBrowserHealth(
  value: unknown,
  record: BrowserCellRecord,
  lastInstance?: string,
): BrowserHealth {
  const parsed = healthSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.browserCellId !== record.id ||
    parsed.data.parentCellId !== record.parentCellId ||
    parsed.data.instance === lastInstance ||
    parsed.data.holder !== "user"
  )
    throw new BrowserLifecycleError("Browser startup identity is invalid");
  return parsed.data;
}

// A running browser still answers as the one that started, ready to be controlled.
export function answersReady(
  value: unknown,
  ready: { browserCellId: string; parentCellId: string; instance: string },
): boolean {
  const parsed = healthSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.ready &&
    parsed.data.browserCellId === ready.browserCellId &&
    parsed.data.parentCellId === ready.parentCellId &&
    parsed.data.instance === ready.instance
  );
}

export function readBrowserHealth(
  port: number,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  return readBrowserd(port, token, signal, "/health");
}

// browserd's account of its Chromium: restarted in place, and what last failed. A browser image
// from before this report answers 404.
export function readBrowserSupervisor(
  port: number,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  return readBrowserd(port, token, signal, "/supervisor");
}

// The last failure browserd reported, in words for the user, the log and the agent.
export function describeBrowserFailure(
  failure: NonNullable<BrowserSupervisorState["lastFailure"]>,
): string {
  const restarted = failure.recovered
    ? " and was restarted"
    : " and could not be restarted in place";
  switch (failure.kind) {
    case "tab_crashed":
      return failure.recovered
        ? `A tab crashed (${failure.detail}) and was reloaded`
        : `A tab keeps crashing (${failure.detail}) and was left on its error page`;
    case "browser_exited":
      return `The browser process ended (${failure.detail})${restarted}`;
    case "unresponsive":
      return `The browser stopped responding (${failure.detail})${restarted}`;
    case "control_lost":
      return `localDot lost its connection to the browser (${failure.detail})${restarted}`;
  }
}

function readBrowserd(
  port: number,
  token: string,
  signal: AbortSignal,
  path: "/health" | "/supervisor",
): Promise<unknown> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/u.test(token))
    return Promise.reject(new BrowserLifecycleError());
  return new Promise((resolve, reject) => {
    const fail = () => reject(new BrowserLifecycleError("Browser readiness probe failed"));
    const pending = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path,
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        headers: { authorization: `Bearer ${token}`, connection: "close" },
      },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("error", fail);
        if (response.statusCode !== 200) {
          response.destroy();
          pending.destroy();
          fail();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) {
            response.destroy();
            pending.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            signal.throwIfAborted();
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            fail();
          }
        });
      },
    );
    pending.on("error", fail);
    pending.end();
  });
}
