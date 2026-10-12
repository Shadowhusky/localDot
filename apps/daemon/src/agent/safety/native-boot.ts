import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateRecords } from "./private-records.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NativeBoot = z.strictObject({
  host: z.string().regex(/^[0-9a-f]{64}$/),
  boot: z.string().regex(uuid),
});
export type NativeBoot = z.infer<typeof NativeBoot>;

// OS identities, not daemon PIDs, timestamps, uptime estimates or Docker's VM boot.
// A daemon restart can leave native children alive; an OS reboot cannot.
export function readNativeBoot(): NativeBoot | undefined {
  try {
    let host: string, boot: string;
    if (process.platform === "darwin") {
      const run = (file: string, args: string[]) =>
        execFileSync(file, args, {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 65536,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      boot = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
      host =
        run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).match(
          /"IOPlatformUUID" = "([0-9a-f-]{36})"/i,
        )?.[1] ?? "";
      if (!uuid.test(host)) return undefined;
    } else if (process.platform === "linux") {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      host = readFileSync("/etc/machine-id", "utf8").trim();
      if (!/^[0-9a-f]{32}$/i.test(host)) return undefined;
    } else return undefined;
    return NativeBoot.parse({
      host: createHash("sha256").update(`${process.platform}:${host.toLowerCase()}`).digest("hex"),
      boot: boot.toLowerCase(),
    });
  } catch {
    return undefined;
  }
}

const BootRecord = NativeBoot.extend({
  cellId: z.string().regex(ULID_PATTERN),
  sessionId: z.string().regex(ULID_PATTERN),
  revision: z.number().int().positive().safe(),
});
export class NativeBootRecords extends PrivateRecords<z.infer<typeof BootRecord>> {
  constructor(home: string) {
    super(home, "native-boots", (raw, id) => {
      const record = BootRecord.parse(raw);
      if (record.cellId !== id) throw new Error("native boot owner mismatch");
      return record;
    });
  }
}
