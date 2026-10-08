import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { runOpenLink } from "../../../daemon/src/open-link.ts";
import { parsePort } from "../../../daemon/src/port.ts";
import type { ConsoleIO } from "../runtime.ts";
import { activateInstalledRelease } from "./activate-release.ts";
import { isInstallerBrowserURL, openInstallerBrowser } from "./browser-open.ts";
import { type InstallProgressBrowser, startInstallProgressBrowser } from "./browser-progress.ts";
import { installHostProbes } from "./host-probes.ts";
import { hasInstallState, initializeInstallHome } from "./initialize-home.ts";
import { runInstallPreflight } from "./preflight.ts";
import { withPreparedRelease } from "./prepare-release.ts";
import { serviceJournalStore } from "./service-journal.ts";
import { runUp } from "./up.ts";
import { updateJournalStore } from "./update-journal.ts";

export interface DefaultContext {
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  signal: AbortSignal;
}

/** npx localdot: reuse an existing installation, otherwise authenticate and install this build's
 * release version. No mutable "latest" tag becomes executable authority. Preparation holds the helper
 * mutex through image preparation, activation, exact readiness and one-use link issuance.
 */
export async function runDefault(input: DefaultContext, io: ConsoleIO): Promise<number> {
  const context = { ...input, env: { ...input.env } },
    signal = context.signal;
  let browser: InstallProgressBrowser | undefined;
  let signInURL: string | undefined;
  const linkIO: ConsoleIO = {
    err: (message) => io.err(message),
    out: (message) => {
      // The existing issuer validates the response. Capture only its exact local one-use URL,
      // while preserving the terminal fallback and never reading/reprinting a reusable token.
      if (isInstallerBrowserURL(message) && message.includes("/#code=")) signInURL = message;
      io.out(message);
    },
  };
  const showWorkspace = async () => {
    if (!signInURL || signal.aborted) return;
    if (browser) {
      try {
        if (await browser.finish("ready", signInURL)) return;
      } catch {
        await browser.close();
      }
    }
    if (!(await openInstallerBrowser(signInURL, signal).catch(() => false)) && !signal.aborted)
      io.err("Could not open the browser. Use the sign-in link above.");
  };
  try {
    signal.throwIfAborted();
    const uid = process.getuid?.();
    if (!uid) throw new Error("Missing user identity");
    const scope = { home: context.home, state: join(context.home, "install"), uid };
    let recordedSettings: ServiceConfiguration["settings"] | undefined;
    if (await hasInstallState(context.home)) {
      const record = await serviceJournalStore(scope).read();
      const update = await updateJournalStore(scope.state).read();
      if (record) {
        // An unfinished first install needs preparation after rollback. All established installs
        // use the offline existing-install path and ignore ambient port/socket/version changes.
        if (!update || update.previous !== null || update.phase === "committed") {
          const result = await runUp({ home: context.home, signal }, linkIO);
          if (result === 0) await showWorkspace();
          return signal.aborted ? 130 : result;
        }
        recordedSettings = record.configuration.settings;
      } else if (update && (update.previous !== null || update.phase === "committed")) {
        throw new Error("Existing service authority is missing");
      }
    }
    if (context.version.length > 64 || !RELEASE_VERSION.test(context.version))
      throw new Error("Invalid build version");
    const port = recordedSettings?.port ?? parsePort(context.env.LOCALDOT_PORT);
    if (port < 1024) throw new Error("An unprivileged port is required");
    const env = recordedSettings
      ? { ...context.env, DOCKER_HOST: `unix://${recordedSettings.dockerSocket}` }
      : context.env;
    let socket: string | undefined;
    io.out("Checking this Mac and Docker Desktop…");
    const preflight = await runInstallPreflight(
      context.home,
      signal,
      installHostProbes(env, (value) => {
        socket = value;
      }),
    );
    for (const check of preflight.checks) (check.ok ? io.out : io.err)(check.message);
    if (!preflight.prerequisitesPassed) return 1;
    if (!socket) throw new Error("Docker selection was not confirmed");
    signal.throwIfAborted();
    browser = await startInstallProgressBrowser(port, signal, io);
    signal.throwIfAborted();
    const directories = await initializeInstallHome(context.home, signal);
    const settings = recordedSettings ?? {
      ...directories,
      uid,
      port,
      dockerSocket: socket,
      userHome: await realpath(homedir()),
      node: await realpath(process.execPath),
    };
    io.out("Preparing the verified localDot release…");
    return await withPreparedRelease(
      directories.state,
      context.version,
      signal,
      async (release, active, helper) => {
        let lastProgress = "";
        const readyImages = new Set<string>();
        const activated = await activateInstalledRelease(
          settings,
          release.identity,
          helper.keydPath,
          active,
          (progress) => {
            browser?.report(progress);
            if (progress.phase === "ready") readyImages.add(progress.role);
            if (readyImages.size === 4) browser?.starting();
            const message = `Preparing ${progress.role}: ${progress.phase}…`;
            if (message !== lastProgress) {
              io.out(message);
              lastProgress = message;
            }
          },
        );
        active.throwIfAborted();
        io.out("localDot is ready. Open the sign-in link to finish setup.");
        const result = await runOpenLink(
          { home: directories.home, port: activated.configuration.settings.port, signal: active },
          linkIO,
        );
        if (result === 0) await showWorkspace();
        else await browser?.finish(signal.aborted ? "cancelled" : "failed");
        return signal.aborted ? 130 : result;
      },
    );
  } catch {
    await browser?.finish(signal.aborted ? "cancelled" : "failed").catch(() => {});
    io.err(
      signal.aborted
        ? "Setup interrupted. Run localdot again to recover."
        : "Setup could not complete. Check Docker Desktop and the private installation directory, then run localdot again.",
    );
    return signal.aborted ? 130 : 1;
  } finally {
    await browser?.close();
  }
}
