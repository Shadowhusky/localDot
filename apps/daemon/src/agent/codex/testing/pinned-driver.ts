import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppServerRpc,
  CodexLaunchError,
  type CodexProcess,
  decideServerRequest,
  isApprovalCurrent,
} from "@localdot/codex-harness";
import { type ToolResult, ulid } from "@localdot/protocol";
import type { PinnedFixture } from "../../../../../../harness/codex/src/testing/pinned-fixture.ts";
import { EventLog } from "../../../event-log.ts";
import { AgentSession, abortable } from "../../session.ts";
import { TranscriptStore } from "../../transcript.ts";
import { CodexDriver, type TaskConnection, type TaskLaunch } from "../driver.ts";
import { type McpCallContext, type McpEndpoint, openMcpEndpoint } from "../mcp-endpoint.ts";
import { type Answer, fakeAuthJson, startOpenAiMock } from "./openai-mock.ts";

export const PINNED_PNG = Buffer.from(
  // A valid asymmetric 64x48 RGB image, generated with the app's pinned sharp. Comparing the
  // submitted image bytes detects omission, crops and text-only replacements on this pin.
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAVElEQVRo3u3PMQ0AIAwAsImYAx78S+FGBBLwMEg4aFIDjTXaibxpFoSAgICAgICAgICAgIDAs0BvJ/KmWSAgICAgICAgICAgICAgICAgICAg8GNgA38ybuRtMPdHAAAAAElFTkSuQmCC",
  "base64",
);
// Only the explicit offline suite uses this lease. The actual driver, RPC, approval filter,
// endpoint, turn basis and durable transcript run unchanged. There is no production gate bypass.
export async function pinnedDriver(fixture: PinnedFixture, answer?: Answer) {
  const mock = await startOpenAiMock(answer);
  let ownedLog: EventLog | undefined;
  try {
    const log = new EventLog(join(fixture.root, "daemon"));
    ownedLog = log;
    const transcripts = new TranscriptStore(join(fixture.root, "daemon"));
    const session = new AgentSession(
      log.createSession("Inert offline task"),
      ulid(),
      "Inert offline task",
      log,
    );
    const calls: {
      tool: string;
      input: unknown;
      context: McpCallContext;
      completed: boolean;
      resultFrameId?: string;
    }[] = [];
    const decisions: { method: string; verdict: string; params: unknown }[] = [];
    const notes: { method: string; params: unknown }[] = [];
    const endpoints: McpEndpoint[] = [],
      connections: TaskConnection[] = [];
    const failures: unknown[] = [],
      signedOut: number[] = [];
    const frame = ulid();
    const observedFrames: string[] = [];
    let generation = 1,
      active = false,
      closePromise: Promise<void> | undefined;
    let leaseAbort: AbortController | undefined;
    let beforeReply: (() => void | Promise<void>) | undefined;
    let reply: ((tool: string, input: unknown, context: McpCallContext) => ToolResult) | undefined;
    writeFileSync(join(fixture.roots.home, "auth.json"), fakeAuthJson(), { mode: 0o600 });
    const launch = async (input: TaskLaunch): Promise<TaskConnection> => {
      await fixture.verify(input.signal);
      input.signal.throwIfAborted();
      assert.ok(input.isCurrent());
      let owner: CodexProcess | undefined, rpc: AppServerRpc | undefined;
      const connection: TaskConnection = {
        get rpc() {
          assert.ok(rpc);
          return rpc;
        },
        workDir: fixture.work.path,
        get exited() {
          assert.ok(owner);
          return owner.exited;
        },
        get closed() {
          assert.ok(owner);
          return owner.closed;
        },
        get failure() {
          assert.ok(owner);
          return owner.failure.then(() => new CodexLaunchError("transport_failed"));
        },
        stop() {
          input.onFence();
          rpc?.close();
          assert.ok(owner);
          return owner.stop();
        },
      };
      const process = fixture.appServer({
        purpose: "task",
        base: mock.base,
        mcp: input.endpoint.directory,
        signal: input.signal,
        register: (record) => {
          owner = record;
          connections.push(connection);
          input.onRegister(connection);
        },
      });
      try {
        assert.ok(process.stdout);
        assert.ok(process.stdin);
        rpc = new AppServerRpc({
          input: process.stdout,
          output: process.stdin,
          signal: input.signal,
          onServerRequest: (method, params, context) => {
            assert.ok(decisions.length < 128);
            const decision = decideServerRequest(method, params, input.approvalContext());
            decisions.push({ method, params, verdict: decision.verdict });
            if (decision.blocked && input.isCurrent()) input.onBlocked(decision.blocked);
            return {
              ...("result" in decision ? { result: decision.result } : { error: decision.error }),
              current: () =>
                input.isCurrent() &&
                !context.signal.aborted &&
                (decision.verdict !== "approved" || isApprovalCurrent(decision)),
            };
          },
          onNotification: (method, params, context) => {
            assert.ok(notes.length < 2048);
            notes.push({ method, params });
            return input.onNotification(method, params, context);
          },
          onFailure: (error) => {
            failures.push(error);
            input.onFailure(new CodexLaunchError("transport_failed"));
          },
        });
        await process.started;
        assert.ok(input.isCurrent());
        return connection;
      } catch (error) {
        await connection.stop();
        await connection.closed;
        throw error;
      }
    };
    const driver = new CodexDriver({
      auth: {
        get authGeneration() {
          return generation;
        },
        async acquireTask(_id, signal) {
          signal.throwIfAborted();
          assert.equal(active, false);
          active = true;
          const authGeneration = generation,
            abort = new AbortController();
          leaseAbort = abort;
          let connection: TaskConnection | undefined,
            released = false;
          return {
            generation: authGeneration,
            signal: AbortSignal.any([fixture.signal, signal, abort.signal]),
            async launch(input) {
              assert.equal(connection, undefined);
              connection = await launch(input);
              return connection;
            },
            async release() {
              if (released) return;
              if (connection) {
                await connection.stop();
                await connection.closed;
              }
              released = true;
              active = false;
            },
          };
        },
        markSignedOut(current) {
          assert.equal(current, generation);
          signedOut.push(current);
          generation++;
          leaseAbort?.abort(new Error("Inert fixture account retired."));
        },
      },
      transcripts,
      instructions: () => "Only localdot tools; finish with done. Inert offline acceptance.",
      observe: async (_session, brain, signal) => {
        session.check(brain, signal);
        const frameId = observedFrames.length ? ulid() : frame;
        observedFrames.push(frameId);
        return { frameId, full: true, png: Buffer.from(PINNED_PNG) };
      },
      openEndpoint: async (input) => {
        const endpoint = await openMcpEndpoint({
          ...input,
          roots: fixture.roots,
          dispatch: async (tool, _callId, input, context) => {
            assert.ok(calls.length < 128);
            const record = { tool, input, context, completed: false, resultFrameId: ulid() };
            calls.push(record);
            const lease = session.admit(context.generation, context.signal);
            try {
              await abortable(Promise.resolve(beforeReply?.()), lease.signal);
              lease.check();
              record.completed = true;
              return {
                status: 200,
                result:
                  reply?.(tool, input, context) ??
                  (tool === "done"
                    ? {
                        ok: true,
                        final: true,
                        content: [{ type: "text", text: "Offline fixture finished." }],
                      }
                    : {
                        ok: true,
                        content: [
                          {
                            type: "image",
                            frameId: record.resultFrameId,
                            mediaType: "image/png",
                            data: PINNED_PNG.toString("base64"),
                          },
                        ],
                      }),
              };
            } finally {
              lease.finish();
            }
          },
        });
        endpoints.push(endpoint);
        return endpoint;
      },
    });
    const running: Promise<number>[] = [];
    return {
      fixture,
      mock,
      session,
      driver,
      calls,
      decisions,
      notes,
      endpoints,
      connections,
      failures,
      signedOut,
      frame,
      observedFrames,
      transcripts,
      run() {
        const work = driver.run(session, { model: "gpt-6-astra", resume: false });
        running.push(work);
        void work.catch(() => {});
        return work;
      },
      beforeReply(callback: () => void | Promise<void>) {
        beforeReply = callback;
      },
      reply(callback: (tool: string, input: unknown, context: McpCallContext) => ToolResult) {
        reply = callback;
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          const errors: unknown[] = [];
          try {
            session.stop();
          } catch (error) {
            errors.push(error);
          }
          for (const work of running) {
            try {
              await work;
            } catch (error) {
              errors.push(error);
            }
          }
          for (const endpoint of endpoints) {
            try {
              await endpoint.close();
            } catch (error) {
              errors.push(error);
            }
          }
          const output = process.env.LOCALDOT_CODEX_PROBE_OUTPUT;
          try {
            if (output) {
              mkdirSync(output, { recursive: true, mode: 0o700 });
              writeFileSync(
                join(output, `${session.id}.json`),
                `${JSON.stringify(
                  {
                    sessionId: session.id,
                    requests: mock.requests,
                    responses: mock.responses,
                    decisions,
                    notes,
                    signedOut,
                    observedFrames,
                    calls: calls.map((call) => ({
                      tool: call.tool,
                      input: call.input,
                      completed: call.completed,
                      basisFrameId: call.context.basisFrameId,
                      resultFrameId: call.resultFrameId,
                    })),
                    failures: failures.map(String),
                  },
                  null,
                  2,
                )}\n`,
                { mode: 0o600 },
              );
            }
          } catch (error) {
            errors.push(error);
          }
          try {
            log.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await mock.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            assert.deepEqual(mock.errors, []);
            assert.equal(active, false);
          } catch (error) {
            errors.push(error);
          }
          try {
            // Stop every owned process even on journal/artifact/mock failure, but retain its
            // private files when this entire fixture has not completed successfully.
            await fixture.close({ retain: errors.length > 0 });
          } catch (error) {
            errors.push(error);
          }
          if (errors.length) throw new AggregateError(errors, "Offline driver cleanup failed.");
        })();
        void closePromise.catch(() => {});
        return closePromise;
      },
    };
  } catch (cause) {
    const errors: unknown[] = [cause];
    try {
      ownedLog?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await mock.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await fixture.close({ retain: true });
    } catch (error) {
      errors.push(error);
    }
    throw new AggregateError(
      errors,
      "Offline driver preparation failed; private fixture retained.",
    );
  }
}
