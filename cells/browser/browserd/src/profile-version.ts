import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const VERSION = /^([0-9]+)(?:\.[0-9]+){3}$/u;
const VERSION_OUTPUT = /^(Google Chrome|Chromium) ([0-9]+(?:\.[0-9]+){3})/mu;
const VERSION_MS = 30_000;

export class BrowserProfileTooNewError extends Error {
  constructor(browser: string, profile: string) {
    super(
      `this browser (${browser}) is older than the one that last opened your sign-ins (${profile}), so it won't open them; use Google Chrome or go back to the backup in Settings → Accounts`,
    );
  }
}

const major = (version: string) => Number(VERSION.exec(version)?.[1]);

function binaryVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        timeout: VERSION_MS,
        maxBuffer: 64 * 1024,
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

// Browsers migrate a profile's databases forward and never back, so a profile opened by a newer
// browser can't be opened safely by an older one. Within a major version the formats don't change.
export async function refuseNewerProfile(
  profilePath: string,
  executable: string,
  versionOf: (executable: string) => Promise<string> = binaryVersion,
): Promise<void> {
  let last: string;
  try {
    last = (await readFile(`${profilePath}/Last Version`, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!VERSION.test(last)) return;
  const binary = VERSION_OUTPUT.exec(await versionOf(executable));
  if (!binary?.[1] || !binary[2]) throw new Error("The browser didn't report its version");
  if (major(binary[2]) < major(last))
    throw new BrowserProfileTooNewError(`${binary[1]} ${binary[2]}`, last);
}
