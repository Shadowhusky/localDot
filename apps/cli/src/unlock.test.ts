import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { KeydVault, Sealed } from "../../../packages/protocol/src/keyd.ts";
import { KeydError } from "../../daemon/src/keyd/client.ts";
import { parseArgs } from "./args.ts";
import { type PassphrasePrompt, runUnlock, terminalPrompt } from "./unlock.ts";

const SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";

function harness(vault: KeydVault | null, answers: string[], refuse = false, known = true) {
  const out: string[] = [];
  const record = { known: () => known, remembered: 0, remember: () => record.remembered++ };
  const err: string[] = [];
  const sent: Sealed[] = [];
  const prompts: string[] = [];
  const keyd = {
    status: async () => ({ sealKey: SEAL_KEY, vault }),
    unlockVault: async (sealed: Sealed): Promise<KeydVault> => {
      sent.push(sealed);
      if (refuse) throw new KeydError(403, "wrong-passphrase", "no", "/v1/vault/unlock");
      return { backend: "file", state: "ready", key: "passphrase" };
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
      record,
    );
  return { run, out, err, sent, prompts, record };
}

const PASS = "correct horse battery staple";

describe("localdot unlock", () => {
  it("warns when the passphrase wasn't set with localdot unlock, and remembers one that works", async () => {
    const elsewhere = harness(
      { backend: "file", state: "locked", key: "passphrase" },
      [PASS],
      false,
      false,
    );
    expect(await elsewhere.run()).toBe(0);
    expect(elsewhere.err.join(" ")).toContain("wasn't set with localdot unlock");
    expect(elsewhere.record.remembered).toBe(1);
    const mine = harness({ backend: "file", state: "locked", key: "passphrase" }, [PASS]);
    expect(await mine.run()).toBe(0);
    expect(mine.err).toEqual([]);
    const fresh = harness({ backend: "file", state: "setup" }, [PASS, PASS], false, false);
    expect(await fresh.run()).toBe(0);
    expect(fresh.err).toEqual([]);
    expect(fresh.record.remembered).toBe(1);
    const wrong = harness({ backend: "file", state: "locked", key: "passphrase" }, [PASS], true);
    expect(await wrong.run()).toBe(1);
    expect(wrong.record.remembered).toBe(0);
  });

  it("refuses a passphrase longer than keyd takes before sending it", async () => {
    const long = harness({ backend: "file", state: "locked", key: "passphrase" }, [
      "é".repeat(600),
    ]);
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
    const short = harness({ backend: "file", state: "locked", key: "passphrase" }, ["short"]);
    expect(await short.run()).toBe(1);
    expect(short.sent).toHaveLength(0);
  });

  it("unlocks a locked vault, and says so plainly when the passphrase is wrong", async () => {
    const ok = harness({ backend: "file", state: "locked", key: "passphrase" }, [PASS]);
    expect(await ok.run()).toBe(0);
    expect(ok.prompts).toEqual(["Passphrase for your saved keys: "]);
    const wrong = harness({ backend: "file", state: "locked", key: "passphrase" }, [PASS], true);
    expect(await wrong.run()).toBe(1);
    expect(wrong.err).toEqual(["That passphrase doesn't unlock your saved keys."]);
  });

  it("asks nothing where keys need no passphrase", async () => {
    for (const vault of [
      { backend: "keychain", state: "ready" as const },
      { backend: "file", state: "ready" as const, key: "tpm" as const },
      null,
    ]) {
      const h = harness(vault, []);
      expect(await h.run()).toBe(0);
      expect(h.prompts).toHaveLength(0);
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
