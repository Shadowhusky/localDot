import assert from "node:assert/strict";
import { createReadStream, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccountRead,
  CODEX_VERSION,
  type CodexConnection,
  LoginCompleted,
  LoginStarted,
  launchCodex,
  prepareOwnedCodexRoots,
} from "@localdot/codex-harness";
import { it } from "vitest";
import { VerifiedCodexInstaller } from "../../../../../harness/codex/src/install.ts";
import {
  privateAuthRefresh,
  requireManualSignIn,
  userCredentialMetadata,
} from "../../../../../harness/codex/src/testing/manual-signin.ts";
import { codexRelease } from "../../../../../harness/codex/src/version.ts";
import { loginFor } from "./account.ts";

// Separate explicit manual command only. No thread, turn, model, quota or reset request exists
// in this suite. Real credentials are confined to a disposable home and never returned/logged.
it("manual device-code cancellation, real ChatGPT sign-in and forced refresh in an owned native home", async () => {
  requireManualSignIn(process.env); // Before filesystem, installer, process or network allocation.
  const home = realpathSync(homedir()),
    before = userCredentialMetadata(home);
  const root = realpathSync(mkdtempSync("/tmp/lds14-")),
    birth = lstatSync(root);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(660_000)]);
  const connections: CodexConnection[] = [],
    failures: string[] = [];
  const completions: { loginId: string; success: boolean }[] = [];
  const errors: unknown[] = [];
  const interrupted = () => lifetime.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const roots = prepareOwnedCodexRoots(join(root, "localdot"), home);
    const release = codexRelease();
    assert.ok(release, "A measured release is required.");
    const installer = new VerifiedCodexInstaller(roots, release, async (url, abort) => {
      assert.equal(url, release.archive.url);
      return {
        status: 200,
        contentLength: release.archive.compressedBytes,
        body: createReadStream(process.env.LOCALDOT_CODEX_ARCHIVE as string, { signal: abort }),
      };
    });
    await installer.ensureInstalled(signal);
    const openAccount = () => {
      let admitted = true;
      return launchCodex(
        { roots },
        {
          purpose: "account",
          signal,
          owner: {
            register: (owner) => {
              connections.push(owner);
            },
            isCurrent: () => admitted,
          },
          onFence: () => {
            admitted = false;
          },
          onFailure: (error) => {
            failures.push(error.code);
          },
          onNotification: (method, params) => {
            if (method !== "account/login/completed") return;
            const parsed = LoginCompleted.safeParse(params);
            assert.ok(
              parsed.success && parsed.data.loginId,
              "The manual login notification is invalid.",
            );
            assert.ok(completions.length < 4, "Too many manual login completions.");
            completions.push({ loginId: parsed.data.loginId, success: parsed.data.success });
          },
        },
      );
    };
    let connection = await openAccount();
    let rpc = connection.rpc;
    const request = async (
      method: "account/login/start" | "account/login/cancel" | "account/read",
      params: unknown,
    ) => {
      try {
        return await rpc.request(method, params, {
          signal,
          timeoutMs: 30_000,
          validateResult: (value: unknown) => value,
        });
      } catch {
        throw new Error("The manual account operation failed; no private reply is printed.");
      }
    };
    const initialize = async () => {
      await rpc.request(
        "initialize",
        { clientInfo: { name: "localdot-manual-acceptance", version: CODEX_VERSION } },
        {
          signal,
          timeoutMs: 30_000,
          validateResult: (value: unknown) => value,
        },
      );
      rpc.notify("initialized", {});
    };
    await initialize();
    const waitCompletion = async (id: string) => {
      for (;;) {
        signal.throwIfAborted();
        assert.equal(failures.length, 0, "The manual account process failed while waiting.");
        const result = completions.find((item) => item.loginId === id);
        if (result) return result.success;
        await delay(100, undefined, { signal });
      }
    };
    const canceled = loginFor(
      LoginStarted.parse(await request("account/login/start", { type: "chatgptDeviceCode" })),
      "code",
      Date.now(),
    );
    const cancelReply = await request("account/login/cancel", { loginId: canceled.loginId });
    assert.ok(
      cancelReply &&
        typeof cancelReply === "object" &&
        (cancelReply as { status?: unknown }).status === "canceled",
      "The owned device-code attempt was not canceled.",
    );
    assert.equal(
      await waitCompletion(canceled.loginId),
      false,
      "The canceled attempt completed unexpectedly.",
    );
    await connection.stop();
    await connection.closed;
    connection = await openAccount();
    rpc = connection.rpc;
    await initialize();
    const login = loginFor(
      LoginStarted.parse(await request("account/login/start", { type: "chatgptDeviceCode" })),
      "code",
      Date.now(),
    );
    assert.ok(
      login.verificationUrl && login.userCode,
      "A verified device-code response is required.",
    );
    process.stdout.write(
      `Manual sign-in: open ${login.verificationUrl} and enter ${login.userCode}.\n`,
    );
    assert.equal(await waitCompletion(login.loginId), true, "The manual sign-in did not succeed.");
    // Completion is emitted before the pin finishes reloading its cached account. Retire
    // the login owner and read from a fresh verified process, as the production owner does.
    await connection.stop();
    await connection.closed;
    connection = await openAccount();
    rpc = connection.rpc;
    await initialize();
    const account = AccountRead.safeParse(await request("account/read", { refreshToken: false }));
    assert.ok(
      account.success && account.data.account?.type === "chatgpt",
      "The owned account is not signed in with ChatGPT.",
    );
    const first = privateAuthRefresh(roots.home);
    const refreshed = AccountRead.safeParse(await request("account/read", { refreshToken: true }));
    assert.ok(
      refreshed.success && refreshed.data.account?.type === "chatgpt",
      "The forced manual refresh did not return a ChatGPT account.",
    );
    assert.ok(
      privateAuthRefresh(roots.home) > first,
      "The owned credential refresh timestamp did not advance.",
    );
    assert.equal(failures.length, 0, "The native account connection reported a failure.");
  } catch (error) {
    errors.push(error);
  } finally {
    lifetime.abort();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    const retired = await Promise.allSettled(
      connections.map(async (owner) => {
        await owner.stop();
        await owner.closed;
      }),
    );
    for (const result of retired) if (result.status === "rejected") errors.push(result.reason);
    try {
      assert.deepEqual(
        userCredentialMetadata(home),
        before,
        "The user's credential metadata changed during manual acceptance.",
      );
    } catch (error) {
      errors.push(error);
    }
    if (!errors.length) {
      const now = lstatSync(root);
      assert.ok(
        now.isDirectory() &&
          !now.isSymbolicLink() &&
          now.dev === birth.dev &&
          now.ino === birth.ino &&
          now.uid === process.getuid?.() &&
          (now.mode & 0o777) === 0o700 &&
          realpathSync(root) === root,
        "The owned manual home changed identity.",
      );
      rmSync(root, { recursive: true });
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Manual acceptance failed; its private home is retained.");
}, 700_000);
