import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { KeydVault, Sealed } from "../../../packages/protocol/src/keyd.ts";
import { KeydError } from "../../daemon/src/keyd/client.ts";
import { parseArgs } from "./args.ts";
import { type PassphrasePrompt, passphraseRecord, runUnlock, terminalPrompt } from "./unlock.ts";

const SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";
const MINE = "0123456789abcdef0123456789abcdef";
const ANEW = "fedcba9876543210fedcba9876543210";
const MADE = "00112233445566778899aabbccddeeff";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function harness(
  vault: KeydVault | null,
  answers: string[],
  { refuse = false, chosen = MINE }: { refuse?: boolean; chosen?: string | null } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "localdot-unlock-"));
  homes.push(home);
  const path = join(home, "passphrase-chosen");
  if (chosen !== null) writeFileSync(path, `${chosen}\n`);
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sealed[] = [];
  const prompts: string[] = [];
  const keyd = {
    status: async () => ({ sealKey: SEAL_KEY, vault }),
    unlockVault: async (sealed: Sealed): Promise<KeydVault> => {
      sent.push(sealed);
      if (refuse) throw new KeydError(403, "wrong-passphrase", "no", "/v1/vault/unlock");
      return {
        backend: "file",
        state: "ready",
        key: "passphrase",
        fingerprint: vault?.fingerprint ?? MADE,
      };
    },
  };
  const prompt: PassphrasePrompt = {
    read: async (text) => {
      prompts.push(text);
      return answers.shift() ?? "";
    },
  };
  const run = () =>
    runUnlock(
      new AbortController().signal,
      { out: (m) => out.push(m), err: (m) => err.push(m) },
      keyd,
      prompt,
      passphraseRecord(path),
    );
  const remembered = () => (existsSync(path) ? readFileSync(path, "utf8").trim() : undefined);
  return { run, out, err, sent, prompts, remembered, path };
}

const locked = (fingerprint?: string): KeydVault => ({
  backend: "file",
  state: "locked",
  key: "passphrase",
  ...(fingerprint ? { fingerprint } : {}),
});
const PASS = "correct horse battery staple";

describe("localdot unlock", () => {
  it("warns when the passphrase wasn't set with localDot, and remembers one that works", async () => {
    const elsewhere = harness(locked(MINE), [PASS], { chosen: null });
    expect(await elsewhere.run()).toBe(0);
    expect(elsewhere.err.join(" ")).toContain("wasn't set with localDot");
    expect(elsewhere.remembered()).toBe(MINE);
    const mine = harness(locked(MINE), [PASS]);
    expect(await mine.run()).toBe(0);
    expect(mine.err).toEqual([]);
    const fresh = harness({ backend: "file", state: "setup" }, [PASS, PASS], { chosen: null });
    expect(await fresh.run()).toBe(0);
    expect(fresh.err).toEqual([]);
    expect(fresh.remembered()).toBe(MADE);
    const wrong = harness(locked(MINE), [PASS], { refuse: true, chosen: null });
    expect(await wrong.run()).toBe(1);
    expect(wrong.remembered()).toBeUndefined();
  });

  it("warns about a vault made anew, though an earlier vault's passphrase was chosen here", async () => {
    const anew = harness(locked(ANEW), [PASS]);
    expect(await anew.run()).toBe(0);
    expect(anew.err.join(" ")).toContain("wasn't set with localDot");
    expect(anew.remembered()).toBe(ANEW);
    const unnamed = harness(locked(), [PASS]);
    await unnamed.run();
    expect(unnamed.err.join(" ")).toContain("wasn't set with localDot");
    const undated = harness(locked(MINE), [PASS], { chosen: "2026-10-09T12:00:00.000Z" });
    await undated.run();
    expect(undated.err.join(" ")).toContain("wasn't set with localDot");
  });

  it("warns about an unlocked vault whose passphrase something else chose", async () => {
    const ready = { backend: "file", state: "ready", key: "passphrase" } as const;
    const anew = harness({ ...ready, fingerprint: ANEW }, []);
    expect(await anew.run()).toBe(0);
    expect(anew.prompts).toHaveLength(0);
    expect(anew.err.join(" ")).toContain("wasn't set with localDot");
    expect(anew.out).toEqual(["Your saved keys are already unlocked."]);
    expect(anew.remembered()).toBe(MINE);
    const mine = harness({ ...ready, fingerprint: MINE }, []);
    expect(await mine.run()).toBe(0);
    expect(mine.err).toEqual([]);
  });

  it("refuses a passphrase longer than keyd takes before sending it", async () => {
    const long = harness(locked(MINE), ["é".repeat(600)]);
    expect(await long.run()).toBe(1);
    expect(long.err.join(" ")).toContain("Use at most 1024 characters");
    expect(long.sent).toHaveLength(0);
  });

  it("is a command of its own", () => {
    expect(parseArgs(["unlock"])).toEqual({ kind: "unlock" });
    expect(parseArgs(["unlock", PASS])).toBeUndefined();
  });

  it("asks twice for a new vault's passphrase and sends it sealed", async () => {
    const h = harness({ backend: "file", state: "setup" }, [PASS, PASS]);
    expect(await h.run()).toBe(0);
    expect(h.prompts).toHaveLength(2);
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0])).not.toContain(PASS);
    expect(h.out.join(" ")).toContain("each time this machine restarts");
  });

  it("changes nothing when the two entries differ or are too short", async () => {
    const differ = harness({ backend: "file", state: "setup" }, [PASS, `${PASS}!`]);
    expect(await differ.run()).toBe(1);
    expect(differ.sent).toHaveLength(0);
    const short = harness(locked(MINE), ["short"]);
    expect(await short.run()).toBe(1);
    expect(short.sent).toHaveLength(0);
  });

  it("unlocks a locked vault, and says so plainly when the passphrase is wrong", async () => {
    const ok = harness(locked(MINE), [PASS]);
    expect(await ok.run()).toBe(0);
    expect(ok.prompts).toEqual(["Passphrase for your saved keys: "]);
    const wrong = harness(locked(MINE), [PASS], { refuse: true });
    expect(await wrong.run()).toBe(1);
    expect(wrong.err).toEqual(["That passphrase doesn't unlock your saved keys."]);
  });

  it("asks nothing where keys need no passphrase", async () => {
    for (const vault of [
      { backend: "keychain", state: "ready" as const },
      { backend: "file", state: "ready" as const, key: "tpm" as const },
      null,
    ]) {
      const h = harness(vault, [], { chosen: null });
      expect(await h.run()).toBe(0);
      expect(h.prompts).toHaveLength(0);
      expect(h.err).toEqual([]);
    }
  });
});

describe("terminalPrompt", () => {
  const signal = new AbortController().signal;
  const prompt = (chunks: string[], end = true) => {
    const input = Object.assign(new PassThrough(), {
      isTTY: false,
    }) as unknown as NodeJS.ReadStream;
    for (const chunk of chunks) (input as unknown as PassThrough).write(chunk);
    if (end) (input as unknown as PassThrough).end();
    return terminalPrompt(input, new PassThrough());
  };

  it("reads both lines of a piped new passphrase, whatever the chunks", async () => {
    const one = prompt(["first line\nsecond line\n"]);
    expect(await one.read("> ", signal)).toBe("first line");
    expect(await one.read("> ", signal)).toBe("second line");
    const crlf = prompt(["first\r", "\nsecond\r\n"]);
    expect(await crlf.read("> ", signal)).toBe("first");
    expect(await crlf.read("> ", signal)).toBe("second");
  });

  it("ends a read at the end of the input", async () => {
    const short = prompt(["only\n"]);
    expect(await short.read("> ", signal)).toBe("only");
    expect(await short.read("> ", signal)).toBe("");
    const unterminated = prompt(["no newline"]);
    expect(await unterminated.read("> ", signal)).toBe("no newline");
    expect(await unterminated.read("> ", signal)).toBe("");
  });
});
