import { useRef, useState } from "react";
import type { SignInSite } from "../../../../packages/protocol/src/accounts.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import type { AccountsView } from "./useAccounts.ts";

const PLACEHOLDER_ROWS = 3;

const otherHosts = (entry: SignInSite) => entry.hosts.filter((host) => host !== entry.site);

// The sites with sign-ins in dot's web browser, which keeps them between tasks and restarts.
export function AccountsSection({ accounts }: { accounts: AccountsView }) {
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const { phase, sites, pending } = accounts;
  return (
    <div className="settings-accounts">
      <p className="settings-lede">
        Where you and dot are signed in. dot's web browser keeps these sign-ins between tasks and
        restarts.
      </p>
      {phase === "off" ? (
        <Group>
          <EmptyState icon="monitor" title="Your computer is off">
            Turn it on to see your sign-ins.
          </EmptyState>
        </Group>
      ) : phase === "error" ? (
        <Group>
          <GroupRow
            label="Couldn't load your sign-ins"
            trailing={
              <Button variant="quiet" size="sm" onClick={accounts.reload}>
                Try again
              </Button>
            }
          />
        </Group>
      ) : phase === "ready" && sites.length === 0 ? (
        <Group>
          <EmptyState icon="globe" title="No sign-ins yet">
            When you or dot sign in to a site, it shows up here.
          </EmptyState>
        </Group>
      ) : (
        <Group>
          <ul
            className="settings-accounts-list"
            aria-label="Sites with sign-ins"
            aria-busy={phase !== "ready" || undefined}
          >
            {(phase === "ready" ? sites : Array.from({ length: PLACEHOLDER_ROWS }, () => null)).map(
              (entry, index) => (
                <li key={entry?.site ?? `placeholder-${index}`}>
                  <GroupRow
                    leading={<IconTile icon="globe" />}
                    label={
                      <Skeleton loading={!entry} width="14ch">
                        <span>{entry?.site}</span>
                      </Skeleton>
                    }
                    detail={
                      !entry ? (
                        <Skeleton loading width="24ch" />
                      ) : otherHosts(entry).length ? (
                        <span
                          className="settings-accounts-hosts"
                          title={otherHosts(entry).join(", ")}
                        >
                          {otherHosts(entry).join(", ")}
                        </span>
                      ) : undefined
                    }
                    trailing={
                      entry ? (
                        <Button
                          variant="quiet"
                          size="sm"
                          busy={pending === entry.site}
                          disabledReason={
                            pending && pending !== entry.site
                              ? "Wait for the last change"
                              : undefined
                          }
                          aria-label={`Sign out of ${entry.site}`}
                          onClick={() => accounts.signOut(entry.site)}
                        >
                          Sign out
                        </Button>
                      ) : (
                        <span className="settings-accounts-slot" aria-hidden="true" />
                      )
                    }
                  />
                </li>
              ),
            )}
          </ul>
        </Group>
      )}
      <div className="settings-inline settings-accounts-footer">
        <p className="settings-lede" role="status">
          {accounts.failure ??
            (phase === "starting"
              ? "dot's web browser is starting. This takes a few seconds."
              : "")}
        </p>
        <Button
          ref={clearTrigger}
          variant="destructive"
          size="sm"
          busy={pending === "*"}
          disabledReason={
            pending && pending !== "*"
              ? "Wait for the last change"
              : phase === "ready" && sites.length === 0
                ? "There's nothing to sign out of"
                : undefined
          }
          onClick={() => setConfirming(true)}
        >
          Sign out of all sites…
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        anchor={clearTrigger}
        title="Sign out of every site?"
        description="dot's web browser restarts and forgets every sign-in and everything sites saved in it. A task using it now loses its open pages. You can't undo this."
      >
        <Button variant="quiet" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setConfirming(false);
            void accounts.clearAll();
          }}
        >
          Sign out of all
        </Button>
      </Dialog>
    </div>
  );
}
