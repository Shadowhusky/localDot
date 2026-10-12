import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { IMAGE_ROLES } from "../../../../packages/protocol/src/release.ts";
import type { DoctorCheck } from "../../../daemon/src/doctor.ts";
import { recoveryChecks } from "../../../daemon/src/doctor-recovery.ts";
import type { ConsoleIO, RuntimeContext } from "../runtime.ts";
import { readContainerInventory } from "./container-containment.ts";
import { inspectDoctorImages } from "./doctor-images.ts";
import { probeInstalledPort } from "./doctor-port.ts";
import { requestDoctorSelfTests } from "./doctor-selftests.ts";
import { installHostProbes } from "./host-probes.ts";
import { installImageClient } from "./image-client.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { type InstalledCanaryInput, runInstalledCanary } from "./installed-canary.ts";
import { verifyInstalledGateway } from "./network-isolation.ts";
import { runInstallPreflight } from "./preflight.ts";
import {
  installedReleaseVerifier,
  readInstalledLockHelper,
  readInstalledRelease,
} from "./promote-release.ts";
import { releaseLayout } from "./release-layout.ts";
import { serviceJournalStore, verifyServiceConfiguration } from "./service-journal.ts";
import { observeServiceJob } from "./service-observation.ts";
import { verifyServiceReadiness } from "./service-readiness.ts";
import { updateJournalStore } from "./update-journal.ts";

const failure = () => new Error("The managed installation changed or requires recovery.");

/** Installed diagnostics never recover/start/stop installed services, pull images, or delete
 * foreign probes. Separate owned diagnostic resources may be recovered/created/stopped/deleted;
 * the owned gateway probe and containment of failed computers can also mutate Docker.
 * A healthy endpoint must match both observed launchd PIDs and the selected release. */
export async function runInstalledDoctor(context: RuntimeContext, io: ConsoleIO): Promise<number> {
  const { home, signal } = context;
  const input = context.installed && structuredClone(context.installed);
  const checks: DoctorCheck[] = recoveryChecks(home);
  try {
    signal.throwIfAborted();
    const uid = process.getuid?.(),
      state = join(home, "install");
    if (
      !input ||
      !uid ||
      input.settings.home !== home ||
      input.settings.state !== state ||
      input.settings.uid !== uid
    )
      throw failure();
    const records = serviceJournalStore({ home, state, uid });
    const helper = await readInstalledLockHelper(state, input.release, signal);
    await withInstallLock(state, signal, keydLockAcquirer(helper.keydPath), async () => {
      const initial = await records.read();
      if (!initial || !equal(initial.configuration, input)) throw failure();
      const verified = await readInstalledLockHelper(state, input.release, signal);
      if (verified.keydPath !== helper.keydPath || !equal(verified.identity, input.release))
        throw failure();
      const layout = releaseLayout(state, installedReleaseVerifier(state)),
        updates = updateJournalStore(state);
      const update = await updates.read();
      const selected = await layout.current();
      if (
        !update ||
        !equal(selected, input.release) ||
        (update.phase !== "committed" && update.phase !== "rolled-back") ||
        !equal(selected, update.phase === "committed" ? update.candidate : update.previous)
      )
        throw failure();
      const release = await readInstalledRelease(state, input.release, signal);
      const definitions = await verifyServiceConfiguration(input, signal);
      const stable = async () => {
        signal.throwIfAborted();
        if (
          !equal(await records.read(), initial) ||
          !equal(await layout.current(), selected) ||
          !equal(await updates.read(), update)
        )
          throw failure();
        signal.throwIfAborted();
      };
      checks.push({
        name: "installed-release",
        ok: true,
        detail: "Selected release, private configuration and service definitions are verified.",
      });
      const preflight = await runInstallPreflight(
        home,
        signal,
        installHostProbes({ DOCKER_HOST: `unix://${input.settings.dockerSocket}` }),
      );
      checks.push(...preflight.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.message })));
      await stable();
      const client = installImageClient(input.settings.dockerSocket);
      let canary: InstalledCanaryInput | undefined;
      let pinnedImages: Record<string, string> | undefined;
      if (preflight.checks.find((c) => c.name === "docker")?.ok) {
        let engineId: string | undefined;
        let imageIds: Record<string, string> | undefined;
        try {
          const images = await inspectDoctorImages(release.manifest, client, signal);
          engineId = images.engineId;
          imageIds = images.images;
          checks.push(...images.checks);
        } catch {
          signal.throwIfAborted();
          checks.push(
            ...IMAGE_ROLES.map((role) => ({
              name: `image-${role}`,
              ok: false,
              detail: "Image inspection could not be confirmed. Check Docker Desktop and retry.",
            })),
          );
        }
        await stable();
        try {
          const result = await verifyInstalledGateway(input, signal);
          if (!engineId || engineId !== result.engineId) throw failure();
          checks.push({
            name: "isolated-gateway-mode",
            ok: true,
            detail: "The owned internal-network probe has no gateway and its cleanup is confirmed.",
          });
        } catch {
          signal.throwIfAborted();
          checks.push({
            name: "isolated-gateway-mode",
            ok: false,
            detail:
              "Isolation or owned-probe cleanup could not be confirmed. Retry doctor after checking Docker Desktop.",
          });
        }
        await stable();
        // An engine/image change during the gateway probe invalidates the earlier receipt.
        try {
          const after = await inspectDoctorImages(release.manifest, client, signal);
          if (after.engineId !== engineId) throw failure();
          if (!equal(after.images, imageIds)) throw failure();
          for (const c of after.checks)
            if (!c.ok) {
              const earlier = checks.find((item) => item.name === c.name);
              if (earlier) Object.assign(earlier, c);
            }
          if (
            preflight.prerequisitesPassed &&
            after.checks.every((c) => c.ok) &&
            checks.find((c) => c.name === "isolated-gateway-mode")?.ok &&
            after.images.desktop &&
            after.images.gate
          ) {
            pinnedImages = { ...after.images };
            canary = {
              configuration: input,
              verifiedKeydPath: helper.keydPath,
              releaseDirectory: release.directory,
              manifest: release.manifest,
              engineId: after.engineId,
              imageIds: { desktop: after.images.desktop, gate: after.images.gate },
            };
          }
        } catch {
          signal.throwIfAborted();
          checks.push({
            name: "docker-stability",
            ok: false,
            detail:
              "Docker or release images changed during diagnostics. Retry after Docker is stable.",
          });
        }
      } else {
        checks.push(
          ...[...IMAGE_ROLES.map((role) => `image-${role}`), "isolated-gateway-mode"].map(
            (name) => ({
              name,
              ok: false,
              detail: "Not checked because the Docker prerequisites failed.",
            }),
          ),
        );
      }
      await stable();
      let servicesStable: (() => Promise<void>) | undefined;
      let selfTestCheck: DoctorCheck = {
        name: "cell-self-tests",
        ok: false,
        detail:
          "Fresh self-tests require the verified installed services and an idle, running computer.",
      };
      try {
        if (
          initial.phase !== "running" ||
          initial.jobs.keyd.phase !== "running" ||
          initial.jobs.daemon.phase !== "running"
        )
          throw failure();
        const observed = async () => {
          const keyd = await observeServiceJob(definitions.keyd, signal),
            daemon = await observeServiceJob(definitions.daemon, signal);
          if (
            initial.jobs.keyd.phase !== "running" ||
            initial.jobs.daemon.phase !== "running" ||
            keyd?.pid !== initial.jobs.keyd.pid ||
            daemon?.pid !== initial.jobs.daemon.pid
          )
            throw failure();
        };
        await observed();
        const expected = {
          home,
          port: input.settings.port,
          identity: { ownerId: input.settings.ownerId, release: input.release },
          keydPid: initial.jobs.keyd.pid,
          daemonPid: initial.jobs.daemon.pid,
        };
        const ready = await verifyServiceReadiness(expected, signal);
        try {
          // The daemon's display inventory can omit unreadable records. Independently require
          // every private desktop record before accepting a complete diagnostic receipt.
          const before = await readContainerInventory(home);
          if (before.invalid) throw failure();
          signal.throwIfAborted();
          const reply = await requestDoctorSelfTests({ ...expected, bootId: ready.bootId }, signal);
          const after = await readContainerInventory(home);
          if (
            after.invalid ||
            after.digest !== before.digest ||
            !equal(
              before.records
                .filter((record) => record.kind === "desktop")
                .map((record) => record.id)
                .sort(),
              reply.cells.map((cell) => cell.id).sort(),
            )
          )
            throw failure();
          const passed = reply.cells.filter((cell) => cell.outcome === "passed").length;
          selfTestCheck = {
            name: "cell-self-tests",
            ok: reply.cells.length > 0 && passed === reply.cells.length,
            detail:
              reply.cells.length === 0
                ? "No computers were tested. Start a computer and leave it idle, then retry doctor."
                : `${passed} of ${reply.cells.length} computers passed fresh self-tests. Failed checks contain the affected computer; busy, stopped or changed computers cannot confirm a pass.`,
          };
        } catch {
          signal.throwIfAborted();
          selfTestCheck = {
            name: "cell-self-tests",
            ok: false,
            detail:
              "Fresh computer self-tests could not be confirmed. Leave a running computer idle, then retry doctor.",
          };
        }
        const after = await verifyServiceReadiness(expected, signal);
        if (after.bootId !== ready.bootId) throw failure();
        await observed();
        servicesStable = async () => {
          await observed();
          const current = await verifyServiceReadiness(expected, signal);
          if (current.bootId !== ready.bootId) throw failure();
          await observed();
        };
        checks.push({
          name: `port-${input.settings.port}`,
          ok: true,
          detail:
            "This port serves the authenticated installed daemon; service identities, recovery, audit and hairpin guard are ready.",
        });
      } catch {
        signal.throwIfAborted();
        selfTestCheck = {
          name: "cell-self-tests",
          ok: false,
          detail:
            "Service readiness changed or is unavailable; computer self-test results could not be confirmed.",
        };
        let portCheck: DoctorCheck = {
          name: `port-${input.settings.port}`,
          ok: false,
          detail:
            "The installed services could not confirm readiness on this port. Run localdot up; doctor does not start services.",
        };
        if (
          initial.phase === "stopped" &&
          initial.jobs.keyd.phase === "absent" &&
          initial.jobs.daemon.phase === "absent"
        ) {
          try {
            const absent = async () => {
              if (
                (await observeServiceJob(definitions.keyd, signal)) !== null ||
                (await observeServiceJob(definitions.daemon, signal)) !== null
              )
                throw failure();
              signal.throwIfAborted();
            };
            await absent();
            const port = await probeInstalledPort(input.settings.port, signal);
            await absent();
            servicesStable = async () => {
              await absent();
              if ((await probeInstalledPort(input.settings.port, signal)) !== port) throw failure();
              await absent();
            };
            portCheck = {
              name: `port-${input.settings.port}`,
              ok: port === "free",
              detail:
                port === "free"
                  ? "The recorded loopback port is free and installed service jobs are absent. Run localdot up to start the app."
                  : port === "occupied"
                    ? "The recorded loopback port is occupied while installed service jobs are absent. Close the other app using this port, then run localdot up."
                    : "The recorded loopback port could not be checked. Installed service jobs are absent; check local permissions before running localdot up.",
            };
            selfTestCheck.detail =
              "Installed services are stopped. Run localdot up, start a computer and leave it idle before retrying self-tests.";
          } catch {
            signal.throwIfAborted();
            portCheck.detail =
              "Stopped service state could not be confirmed. Run localdot up to check or recover the installation; no port owner was changed.";
          }
        }
        checks.push(portCheck);
      }
      await stable();
      // The canary remains a separate required exercise, not implied by self-test readiness.
      checks.push(selfTestCheck);
      let canaryCheck: DoctorCheck = {
        name: "secret-canary",
        ok: false,
        detail: "Not checked because the host, Docker images or isolation prerequisites failed.",
      };
      if (canary) {
        try {
          const verifyImages = async () => {
            const current = await inspectDoctorImages(release.manifest, client, signal);
            if (
              !canary ||
              current.engineId !== canary.engineId ||
              !current.checks.every((c) => c.ok) ||
              !equal(current.images, pinnedImages)
            )
              throw failure();
          };
          await verifyImages();
          await stable();
          await runInstalledCanary(canary, signal);
          await verifyImages();
          canaryCheck = {
            name: "secret-canary",
            ok: true,
            detail:
              "Credential exercise and bounded memory, file and log scans passed; diagnostic cleanup is confirmed.",
          };
        } catch {
          signal.throwIfAborted();
          canaryCheck.detail =
            "The credential diagnostic failed or cleanup requires recovery. Check Docker Desktop, then retry localdot doctor.";
        }
      }
      await stable();
      await servicesStable?.();
      await stable();
      checks.push(canaryCheck);
    });
    signal.throwIfAborted();
    for (const check of checks)
      io.out(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(24)} ${check.detail}`);
    return checks.every((check) => check.ok) ? 0 : 1;
  } catch {
    io.err(
      signal.aborted
        ? "Diagnostics interrupted; owned-probe cleanup was awaited."
        : "Installed diagnostics could not be completed. Run localdot up to check or recover the installation, then retry localdot doctor.",
    );
    return signal.aborted ? 130 : 1;
  }
}
