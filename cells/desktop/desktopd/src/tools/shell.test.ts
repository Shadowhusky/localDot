import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ShellChunk } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShell, type ShellOptions, shellEnv } from "./shell.ts";

let home: string;
let env: NodeJS.ProcessEnv;
const ownedPids = new Set<number>();
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "local dot's shell-")));
  env = shellEnv({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, home);
});
afterEach(async () => {
  try {
    for (const pid of ownedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.all([...ownedPids].map(waitForDeath));
  } finally {
    ownedPids.clear();
    rmSync(home, { recursive: true, force: true });
  }
});

function running(pid: number): boolean {
  // A killed orphan may briefly remain a zombie on Linux; it cannot execute or hold the pipes.
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .startsWith("Z");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

async function waitForDeath(pid: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (running(pid) && performance.now() < deadline) await delay(20);
  expect(running(pid), `fixture PID ${pid} still running`).toBe(false);
}

async function run(
  command: string,
  extra: Partial<ShellOptions> = {},
  onChunk?: (chunk: ShellChunk) => void,
) {
  const chunks: ShellChunk[] = [];
  let stdout = "";
  const done = await runShell(
    { command, cwd: home, timeoutMs: 3000, maxOutputBytes: 1 << 20, env, ...extra },
    (chunk) => {
      chunks.push(chunk);
      if (chunk.stream === "stdout") {
        stdout += chunk.chunk;
        for (const match of stdout.matchAll(/PID:(\d+)\n/g)) ownedPids.add(Number(match[1]));
      }
      onChunk?.(chunk);
    },
  );
  return {
    done,
    chunks,
    stdout,
    stderr: chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join(""),
  };
}

describe("shellEnv", () => {
  it("strips desktopd/stream credentials and settings while preserving surrogates and proxy setup", () => {
    const input = {
      PATH: "/usr/bin:/bin",
      LOCALDOT_DESKTOPD_TOKEN: "inbound-secret",
      LOCALDOT_DESKTOPD_PORT: "7700",
      LOCALDOT_DESKTOPD_FUTURE_SECRET: "future-secret",
      PASSWORD: "stream-secret",
      CUSTOM_USER: "localdot",
      LOCALDOT_SCALE: "2",
      LOCALDOT_KEY_WEATHER: "surrogate-value",
      HTTP_PROXY: "http://127.0.0.1:3129",
      HTTPS_PROXY: "http://127.0.0.1:3129",
      LANG: "C.UTF-8",
      HOME: "/unwanted",
      PAGER: "less",
      GIT_PAGER: "less",
    };
    const actual = shellEnv(input, home);
    expect(actual).toEqual({
      PATH: input.PATH,
      LOCALDOT_KEY_WEATHER: input.LOCALDOT_KEY_WEATHER,
      HTTP_PROXY: input.HTTP_PROXY,
      HTTPS_PROXY: input.HTTPS_PROXY,
      LANG: input.LANG,
      HOME: home,
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      DEBIAN_FRONTEND: "noninteractive",
    });
    expect(input.LOCALDOT_DESKTOPD_TOKEN).toBe("inbound-secret");
  });
});

describe("runShell", () => {
  it("streams both outputs and preserves a nonzero exit code", async () => {
    const result = await run("echo hello; echo oops >&2; exit 3");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("oops\n");
    expect(result.done).toMatchObject({
      done: true,
      exitCode: 3,
      signal: null,
      timedOut: false,
      truncated: false,
    });
  });

  it("runs a login shell in the selected cwd with filtered environment", async () => {
    const result = await run(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion is the fixture.
      'pwd; printf "%s|%s|%s|%s|%s\\n" "$HOME" "${LOCALDOT_DESKTOPD_TOKEN-unset}" "${PASSWORD-unset}" "$LOCALDOT_KEY_WEATHER" "$HTTP_PROXY"; shopt -q login_shell',
      {
        env: shellEnv(
          {
            ...env,
            LOCALDOT_DESKTOPD_TOKEN: "secret",
            PASSWORD: "secret",
            LOCALDOT_KEY_WEATHER: "surrogate",
            HTTP_PROXY: "http://127.0.0.1:3129",
          },
          home,
        ),
      },
    );
    expect(result.stdout).toBe(`${home}\n${home}|unset|unset|surrogate|http://127.0.0.1:3129\n`);
    expect(result.done.exitCode).toBe(0);
  });

  it("returns promptly after successful shell exit while the background child remains alive", async () => {
    const started = performance.now();
    const abort = new AbortController();
    const result = await run('sleep 30 & printf "started PID:%s\\n" "$!"', {
      timeoutMs: 1000,
      signal: abort.signal,
    });
    expect(result.stdout).toMatch(/^started PID:\d+\n$/);
    expect(result.done).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
    });
    expect(performance.now() - started).toBeLessThan(900);
    const pid = [...ownedPids][0];
    expect(pid).toBeDefined();
    expect(running(pid as number)).toBe(true);
    abort.abort(); // The completed command no longer owns a Stop listener.
    await delay(20);
    expect(running(pid as number)).toBe(true);
  });

  it("kills the foreground group and descendants when the deadline expires", async () => {
    const started = performance.now();
    const result = await run('printf "PID:%s\\n" "$$"; sleep 30 & printf "PID:%s\\n" "$!"; wait', {
      timeoutMs: 180,
    });
    expect(result.done).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(ownedPids.size).toBe(2);
    await Promise.all([...ownedPids].map(waitForDeath));
  });

  it("aborts the foreground group and descendants", async () => {
    const abort = new AbortController();
    const result = await run(
      'printf "PID:%s\\n" "$$"; sleep 30 & printf "PID:%s\\n" "$!"; wait',
      { signal: abort.signal },
      () => {
        if (ownedPids.size === 2) abort.abort();
      },
    );
    expect(result.done).toMatchObject({ timedOut: false, signal: "SIGKILL" });
    expect(ownedPids.size).toBe(2);
    await Promise.all([...ownedPids].map(waitForDeath));
  });

  it("still kills descendants when aborted during the pipe drain", async () => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await run(
        'sleep 30 & printf "PID:%s\\n" "$!"',
        { signal: abort.signal },
        () => {
          timer ??= setTimeout(() => abort.abort(), 100);
        },
      );
      expect(result.done.exitCode).toBe(0);
      expect(ownedPids.size).toBe(1);
      await Promise.all([...ownedPids].map(waitForDeath));
    } finally {
      clearTimeout(timer);
    }
  });

  it("does not spawn any command for an already-aborted signal", async () => {
    const abort = new AbortController();
    const reason = new Error("already stopped");
    abort.abort(reason);
    await expect(run("touch should-not-exist", { signal: abort.signal })).rejects.toBe(reason);
    expect(existsSync(join(home, "should-not-exist"))).toBe(false);
  });

  it("caps combined output and kills the process group", async () => {
    const result = await run('printf "PID:%s\\n" "$$"; sleep 30 & printf "PID:%s\\n" "$!"; yes x', {
      maxOutputBytes: 4096,
    });
    expect(result.done).toMatchObject({ truncated: true, signal: "SIGKILL" });
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(4096);
    expect(ownedPids.size).toBe(2);
    await Promise.all([...ownedPids].map(waitForDeath));
  });

  it("applies a shared cap to stdout and stderr and permits an exact fit", async () => {
    const exact = await run("printf ab; printf cd >&2", { maxOutputBytes: 4 });
    expect(exact.done.truncated).toBe(false);
    expect(exact.stdout).toBe("ab");
    expect(exact.stderr).toBe("cd");
    const over = await run("printf abc; printf def >&2", { maxOutputBytes: 4 });
    expect(over.done.truncated).toBe(true);
    expect(Buffer.byteLength(over.stdout + over.stderr)).toBe(4);
  });

  it("keeps UTF-8 characters split across reads whole on each stream", async () => {
    const result = await run(
      "printf 'caf\\xc3'; printf '\\xe4' >&2; sleep 0.05; printf '\\xa9\\n'; printf '\\xb8\\xad\\n' >&2",
    );
    expect(result.stdout).toBe("café\n");
    expect(result.stderr).toBe("中\n");
  });

  it("never emits a partial character or extra replacement bytes at the cap", async () => {
    const unicode = await run("printf 'a\\xe4\\xb8\\xad!'; sleep 30", { maxOutputBytes: 3 });
    expect(unicode.stdout).toBe("a");
    expect(unicode.done.truncated).toBe(true);
    const invalid = await run("printf '\\xff\\xff'; sleep 30", { maxOutputBytes: 2 });
    expect(Buffer.byteLength(invalid.stdout)).toBeLessThanOrEqual(2);
    expect(invalid.done.truncated).toBe(true);
  });

  it("reports spawn failures and returns without waiting for the timeout", async () => {
    const started = performance.now();
    await expect(run("echo never", { shell: join(home, "missing-shell") })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(run("echo never", { cwd: join(home, "missing-cwd") })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("cleans up the group and rejects if the output consumer throws", async () => {
    const failure = new Error("consumer failed");
    await expect(
      run('sleep 30 & printf "PID:%s\\n" "$!"; wait', {}, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(ownedPids.size).toBe(1);
    await Promise.all([...ownedPids].map(waitForDeath));
  });

  it("rejects unbounded and invalid deadlines/output limits before spawning", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Infinity, 0.5, 600001]) {
      await expect(run("touch invalid-limit", { timeoutMs })).rejects.toThrow(RangeError);
    }
    for (const maxOutputBytes of [0, -1, Number.NaN, Infinity, 1.5, 4194305]) {
      await expect(run("touch invalid-limit", { maxOutputBytes })).rejects.toThrow(RangeError);
    }
    expect(existsSync(join(home, "invalid-limit"))).toBe(false);
  });
});
