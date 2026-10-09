import { existsSync, writeFileSync } from "node:fs";
import type { KeydStatus, KeydVault, Sealed } from "../../../packages/protocol/src/keyd.ts";
import { sealPassphrase } from "../../../packages/protocol/src/seal.ts";
import { KeydError } from "../../daemon/src/keyd/client.ts";
import type { ConsoleIO } from "./runtime.ts";

export const MIN_PASSPHRASE = 12;
// keyd takes up to 1024 bytes.
export const MAX_PASSPHRASE_BYTES = 1024;

export interface PassphrasePrompt {
  read(prompt: string, signal: AbortSignal): Promise<string>;
}

// Whether this machine's passphrase was chosen or entered with localdot unlock. The first
// passphrase keyd hears becomes the vault's, from whichever program sends it.
export interface PassphraseRecord {
  known(): boolean;
  remember(): void;
}

export function passphraseRecord(path: string): PassphraseRecord {
  return {
    known: () => existsSync(path),
    remember: () => writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 }),
  };
}

export interface UnlockKeyd {
  status(): Promise<Pick<KeydStatus, "sealKey" | "vault">>;
  unlockVault(sealed: Sealed): Promise<KeydVault>;
}

/** Sets or enters the file vault's passphrase. It is sealed to keyd here, so the daemon never
 * reads it, and it is never echoed, logged or passed on a command line. */
export async function runUnlock(
  signal: AbortSignal,
  io: ConsoleIO,
  keyd: UnlockKeyd,
  prompt: PassphrasePrompt,
  record: PassphraseRecord,
): Promise<number> {
  const status = await keyd.status();
  const vault = status.vault;
  if (vault?.backend !== "file") {
    io.out("Your saved keys don't use a passphrase on this machine.");
    return 0;
  }
  if (vault.state === "ready") {
    io.out("Your saved keys are already unlocked.");
    return 0;
  }
  const setup = vault.state === "setup";
  if (!setup && !record.known())
    io.err(
      "Your saved keys already have a passphrase that wasn't set with localdot unlock. If you don't know it, something else chose it: see Saved keys in docs/install.md to start over.",
    );
  const passphrase = await prompt.read(
    setup
      ? `Choose a passphrase for your saved keys (${MIN_PASSPHRASE} or more characters): `
      : "Passphrase for your saved keys: ",
    signal,
  );
  if (passphrase.length < MIN_PASSPHRASE) {
    io.err(`Use at least ${MIN_PASSPHRASE} characters. Nothing changed.`);
    return 1;
  }
  if (Buffer.byteLength(passphrase) > MAX_PASSPHRASE_BYTES) {
    io.err(
      `Use at most ${MAX_PASSPHRASE_BYTES} characters, fewer with accented or non-Latin letters. Nothing changed.`,
    );
    return 1;
  }
  if (setup && (await prompt.read("Type it again: ", signal)) !== passphrase) {
    io.err("The two passphrases differ. Nothing changed.");
    return 1;
  }
  signal.throwIfAborted();
  try {
    await keyd.unlockVault(await sealPassphrase(status.sealKey, passphrase));
  } catch (error) {
    if (error instanceof KeydError && error.status === 403) {
      io.err("That passphrase doesn't unlock your saved keys.");
      return 1;
    }
    throw error;
  }
  record.remember();
  io.out(
    setup
      ? "Your saved keys are protected. You'll need this passphrase each time this machine restarts."
      : "Your saved keys are unlocked.",
  );
  return 0;
}

/** Reads one line from the terminal without showing it; from a pipe, reads one line. A pipe may
 * bring both lines of a new passphrase at once, so what follows a line waits for the next read. */
export function terminalPrompt(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): PassphrasePrompt {
  let pending = "";
  let afterReturn = false;
  return {
    read(prompt, signal) {
      output.write(prompt);
      return new Promise((resolve, reject) => {
        let text = "";
        let done = false;
        const tty = input.isTTY === true;
        const finish = (error?: Error) => {
          done = true;
          input.off("data", onData);
          input.off("end", onEnd);
          signal.removeEventListener("abort", onAbort);
          if (tty) input.setRawMode(false);
          input.pause();
          if (tty) output.write("\n");
          if (error) reject(error);
          else resolve(text);
        };
        const take = (chunk: string) => {
          const chars = [...chunk];
          for (const [i, char] of chars.entries()) {
            if (afterReturn) {
              afterReturn = false;
              if (char === "\n") continue;
            }
            if (char === "\r" || char === "\n") {
              afterReturn = char === "\r";
              pending = chars.slice(i + 1).join("");
              return finish();
            }
            if (char === "\u0003") return finish(new Error("Interrupted."));
            if (char === "\u007f" || char === "\b") text = [...text].slice(0, -1).join("");
            else if (char >= " ") text += char;
          }
        };
        const onAbort = () => finish(new Error("Interrupted."));
        const onEnd = () => finish();
        const onData = (chunk: Buffer) => take(chunk.toString("utf8"));
        if (tty) input.setRawMode(true);
        signal.addEventListener("abort", onAbort, { once: true });
        input.on("data", onData);
        input.once("end", onEnd);
        const earlier = pending;
        pending = "";
        take(earlier);
        if (done) return;
        if (input.readableEnded) finish();
        else input.resume();
      });
    },
  };
}
