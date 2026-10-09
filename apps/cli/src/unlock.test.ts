import { describe, expect, it } from "vitest";
import type { KeydVault, Sealed } from "../../../packages/protocol/src/keyd.ts";
import { KeydError } from "../../daemon/src/keyd/client.ts";
import { parseArgs } from "./args.ts";
import { type PassphrasePrompt, runUnlock } from "./unlock.ts";

const SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";

function harness(vault: KeydVault | null, answers: string[], refuse = false) {
  const out: string[] = [];
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
    );
  return { run, out, err, sent, prompts };
}

const PASS = "correct horse battery staple";

describe("localdot unlock", () => {
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
