import { readFileSync, writeFileSync } from "node:fs";

// Which vault's passphrase was chosen or entered through localDot (localdot unlock or the app), by
// keyd's fingerprint of it. The first passphrase keyd hears becomes the vault's, from whichever
// program sends it, and a vault made anew has a new fingerprint.
export interface PassphraseRecord {
  known(fingerprint: string | undefined): boolean;
  remember(fingerprint: string): void;
}

export function passphraseRecord(path: string): PassphraseRecord {
  return {
    known(fingerprint) {
      try {
        return fingerprint !== undefined && readFileSync(path, "utf8").trim() === fingerprint;
      } catch {
        return false;
      }
    },
    remember: (fingerprint) => writeFileSync(path, `${fingerprint}\n`, { mode: 0o600 }),
  };
}
