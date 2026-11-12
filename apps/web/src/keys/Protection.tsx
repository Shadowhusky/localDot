import { t, tc } from "../i18n/index.ts";
import { CommandChip } from "../shell/CommandChip.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import type { IconName } from "../ui/icons.ts";
import { type KeydHealth, UNLOCK, vaultLocked } from "./keys-api.ts";

export const DOCTOR = "localdot doctor";

type Tone = "ok" | "wait" | "bad";

interface Status {
  name: string;
  state: string;
  tone: Tone;
  // Unhealthy: what it means, in one sentence, and the raw error behind it.
  problem?: string;
  details?: string;
  // The command that fixes it, and where to run it.
  fix?: { lead: string; command: string };
}

const CHECKING: Pick<Status, "state" | "tone"> = { state: t`Checking…`, tone: "wait" };
const UNKNOWN: Pick<Status, "state" | "tone"> = { state: t`Unknown`, tone: "wait" };
const KEY_ISOLATION = t`Key isolation`;
const AUDIT_LOG = t`Audit log`;
const NETWORK_PROTECTION = t`Network protection`;
const SAVED_KEYS = t`Saved keys`;

export function protectionOf(health: KeydHealth | null): Status[] {
  const online = health?.online === true;
  const isolation: Status = !health
    ? { name: KEY_ISOLATION, ...CHECKING }
    : online
      ? { name: KEY_ISOLATION, state: t`On`, tone: "ok" }
      : {
          name: KEY_ISOLATION,
          state: t`Off`,
          tone: "bad",
          problem: t`Keys can't be saved or used until it's back on.`,
        };
  const audit: Status = !health
    ? { name: AUDIT_LOG, ...CHECKING }
    : !online
      ? { name: AUDIT_LOG, ...UNKNOWN }
      : health.audit?.ok === false
        ? {
            name: AUDIT_LOG,
            state: t`Paused — keys held`,
            tone: "bad",
            problem: t`localDot can't record when keys are used, so it holds every key back.`,
            details: health.audit.error,
          }
        : { name: AUDIT_LOG, state: tc("status", "Recording"), tone: "ok" };
  const guard = health?.hairpin;
  const network: Status = !health
    ? { name: NETWORK_PROTECTION, ...CHECKING }
    : !online
      ? { name: NETWORK_PROTECTION, ...UNKNOWN }
      : guard?.state === "active"
        ? { name: NETWORK_PROTECTION, state: t`On`, tone: "ok" }
        : guard?.state === "off"
          ? {
              name: NETWORK_PROTECTION,
              state: t`Off`,
              tone: "bad",
              problem: t`Your computer could reach your router through this network's public address.`,
              details: guard.error,
            }
          : {
              name: NETWORK_PROTECTION,
              state: t`Checking`,
              tone: "bad",
              problem: t`It's still finding this network's public address. Until then, your computer could reach your router through it.`,
              details: guard?.error,
            };
  return health?.online && health.vault
    ? [isolation, audit, network, savedKeys(health)]
    : [isolation, audit, network];
}

// Off macOS only: keyd's vault may wait for its passphrase, which the form above this list takes,
// or localdot unlock on the computer itself.
function savedKeys(health: KeydHealth): Status {
  const name = SAVED_KEYS;
  const fix = { lead: t`Or, on the computer running localDot, run:`, command: UNLOCK };
  if (vaultLocked(health))
    return health.vault?.state === "setup"
      ? {
          name,
          state: t`Needs a passphrase`,
          tone: "bad",
          problem: t`Choose a passphrase for saved keys above before you add one.`,
          fix,
        }
      : {
          name,
          state: t`Locked`,
          tone: "bad",
          problem: t`Saved keys are locked. Unlock them above with your passphrase.`,
          fix,
        };
  const vault = health.vault;
  const state =
    vault?.backend === "secret-service"
      ? t`In your keyring`
      : vault?.backend === "memory"
        ? t`Until restart`
        : vault?.key === "passphrase"
          ? t`Unlocked`
          : t`Encrypted`;
  return { name, state, tone: "ok" };
}

function Glyph({ tone }: { tone: Exclude<Tone, "ok"> }) {
  if (tone === "bad") return <Badge kind="dot" tone="attention" label={t`Needs attention`} />;
  return <span className="keys-status-ring" aria-hidden="true" />;
}

const TILE: Record<string, IconName> = {
  [KEY_ISOLATION]: "lock",
  [AUDIT_LOG]: "file-text",
  [NETWORK_PROTECTION]: "shield",
  [SAVED_KEYS]: "key-round",
};

// What keeps keys safe, one row each, so a problem says what it means and how to fix it.
export function Protection({ health }: { health: KeydHealth | null }) {
  return (
    <Group id="keys-protection">
      <ul className="keys-protection">
        {protectionOf(health).map((status) => (
          <li key={status.name} className="keys-status" data-tone={status.tone}>
            <GroupRow
              leading={<IconTile icon={TILE[status.name] ?? "shield"} />}
              label={status.name}
              trailing={
                <span className="keys-status-state">
                  {status.tone === "ok" ? null : <Glyph tone={status.tone} />}
                  <span>{status.state}</span>
                </span>
              }
            >
              {status.problem && (
                <div className="keys-status-help">
                  <p>{status.problem}</p>
                  <div className="keys-status-fix">
                    <span>{status.fix?.lead ?? t`To fix it, run this in Terminal:`}</span>
                    <CommandChip text={status.fix?.command ?? DOCTOR} />
                  </div>
                  {status.details && (
                    <Disclosure summary={t`Details`} className="keys-status-details">
                      <p className="keys-raw">{status.details}</p>
                    </Disclosure>
                  )}
                </div>
              )}
            </GroupRow>
          </li>
        ))}
      </ul>
    </Group>
  );
}
