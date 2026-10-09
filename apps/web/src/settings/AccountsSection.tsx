import { useRef, useState } from "react";
import type { SignInSite } from "../../../../packages/protocol/src/accounts.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
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
      <p className="settings-note">
        Where you and dot are signed in. dot's web browser keeps these sign-ins between tasks and
        restarts, away from the computer's own apps.
      </p>
      {phase === "off" ? (
        <EmptyState layout="start" icon="monitor" title="Turn on your computer to see them." />
      ) : phase === "error" ? (
        <div className="settings-inline">
          <p className="settings-note">Your sign-ins couldn't be read.</p>
          <Button variant="quiet" size="sm" onClick={accounts.reload}>
            Try again
          </Button>
        </div>
      ) : phase === "ready" && sites.length === 0 ? (
        <EmptyState layout="start" icon="globe" title="No sign-ins yet.">
          When you or dot sign in to a site, it shows up here.
        </EmptyState>
      ) : (
        <ul
          className="settings-accounts-list"
          aria-label="Sites with sign-ins"
          aria-busy={phase !== "ready" || undefined}
        >
          {(phase === "ready" ? sites : Array.from({ length: PLACEHOLDER_ROWS }, () => null)).map(
            (entry, index) => (
              <li key={entry?.site ?? `placeholder-${index}`}>
                <span className="settings-accounts-tile" aria-hidden="true">
                  <Icon name="globe" size={16} />
                </span>
                <span className="settings-accounts-text">
                  <Skeleton loading={!entry} width="14ch">
                    <span className="settings-accounts-site">{entry?.site}</span>
                  </Skeleton>
                  {!entry ? (
                    <Skeleton loading width="24ch" />
                  ) : otherHosts(entry).length ? (
                    <span className="settings-accounts-hosts">{otherHosts(entry).join(", ")}</span>
                  ) : null}
                </span>
                {entry ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    busy={pending === entry.site}
                    disabledReason={
                      pending && pending !== entry.site ? "Wait for the last change" : undefined
                    }
                    aria-label={`Sign out of ${entry.site}`}
                    onClick={() => accounts.signOut(entry.site)}
                  >
                    Sign out
                  </Button>
                ) : (
                  <span className="settings-accounts-slot" aria-hidden="true" />
                )}
              </li>
            ),
          )}
        </ul>
      )}
      <div className="settings-inline settings-accounts-footer">
        <p className="settings-note" role="status">
          {accounts.failure ??
            (phase === "starting"
              ? "dot's web browser is starting. This takes a few seconds."
              : "")}
        </p>
        <Button
          ref={clearTrigger}
          variant="secondary"
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
