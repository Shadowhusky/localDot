import type { KeydStatus, KeydVault, Sealed } from "../../../packages/protocol/src/keyd.ts";
import { sealPassphrase } from "../../../packages/protocol/src/seal.ts";
import { KeydError } from "../../daemon/src/keyd/client.ts";
import type { ConsoleIO } from "./runtime.ts";

export const MIN_PASSPHRASE = 12;

export interface PassphrasePrompt {
  read(prompt: string, signal: AbortSignal): Promise<string>;
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
  io.out(
    setup
      ? "Your saved keys are protected. You'll need this passphrase each time this machine restarts."
      : "Your saved keys are unlocked.",
  );
  return 0;
}

/** Reads one line from the terminal without showing it; from a pipe, reads one line. */
export function terminalPrompt(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): PassphrasePrompt {
  return {
    read(prompt, signal) {
      output.write(prompt);
      return new Promise((resolve, reject) => {
        let text = "";
        const tty = input.isTTY === true;
        const finish = (error?: Error) => {
          input.off("data", onData);
          input.off("end", onEnd);
          signal.removeEventListener("abort", onAbort);
          if (tty) input.setRawMode(false);
          input.pause();
          if (tty) output.write("\n");
          if (error) reject(error);
          else resolve(text);
        };
        const onAbort = () => finish(new Error("Interrupted."));
        const onEnd = () => finish();
        const onData = (chunk: Buffer) => {
          for (const char of chunk.toString("utf8")) {
            if (char === "\r" || char === "\n") return finish();
            if (char === "\u0003") return finish(new Error("Interrupted."));
            if (char === "\u007f" || char === "\b") text = [...text].slice(0, -1).join("");
            else if (char >= " ") text += char;
          }
        };
        if (tty) input.setRawMode(true);
        signal.addEventListener("abort", onAbort, { once: true });
        input.on("data", onData);
        input.once("end", onEnd);
        input.resume();
      });
    },
  };
}
