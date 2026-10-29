import { type FormEvent, useRef, useState } from "react";
import { KNOWN_SIGN_INS, type SignInSite } from "../../../../packages/protocol/src/accounts.ts";
import type { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { TextField } from "../ui/TextField.tsx";
import type { ReportControl } from "./reports-api.ts";
import type { AccountsView } from "./useAccounts.ts";
import type { BrowserStatusView } from "./useBrowserStatus.ts";
import type { SignInView } from "./useSignIn.ts";

const PLACEHOLDER_ROWS = 3;
// A problem the browser recovered from stays in view this long.
const RECENT_PROBLEM_MS = 15 * 60_000;
const COMMON_SITES = KNOWN_SIGN_INS.slice(0, 4);

const otherHosts = (entry: SignInSite) => entry.hosts.filter((host) => host !== entry.site);

// Type a site or pick a common one: the web browser opens its sign-in page with the user in control.
function SignInToSite({ signIn, off }: { signIn: SignInView; off: boolean }) {
  const [site, setSite] = useState("");
  const failed = useRef<string | null>(null);
  if (signIn.failure) failed.current = signIn.failure;
  const busy = signIn.pending !== null;
  const unavailable = off ? "Turn on your computer first" : undefined;
  const start = (value: string) => {
    void signIn.start(value).then((opened) => {
      if (opened) setSite("");
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && !unavailable) start(site);
  };
  return (
    <Group>
      <GroupRow
        className="settings-signin"
        label="Sign in to a site"
        detail="Opens in the web browser, where you sign in yourself."
      >
        <div className="settings-signin-body">
          <form className="settings-signin-form" onSubmit={submit}>
            <TextField
              size="sm"
              aria-label="Site"
              prefix={<Icon name="globe" size={16} />}
              placeholder="google.com"
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              maxLength={253}
              value={site}
              aria-invalid={!!signIn.failure || undefined}
              onChange={(event) => {
                setSite(event.target.value);
                if (signIn.failure) signIn.clear();
              }}
            />
            <Button type="submit" busy={busy} disabledReason={unavailable}>
              Sign in
            </Button>
          </form>
          <fieldset className="settings-signin-sites" aria-label="Common sites">
            {COMMON_SITES.map((known) => (
              <Chip
                key={known.site}
                variant="outline"
                aria-busy={signIn.pending === known.site || undefined}
                aria-disabled={busy || !!unavailable || undefined}
                onClick={() => {
                  if (!busy && !unavailable) start(known.site);
                }}
              >
                {known.name}
              </Chip>
            ))}
          </fieldset>
          <Collapse open={!!signIn.failure}>
            <p className="settings-signin-failure" role="alert">
              <Icon name="circle-alert" size={14} />
              {failed.current}
            </p>
          </Collapse>
        </div>
      </GroupRow>
    </Group>
  );
}

// What the web browser is doing, or what last went wrong with it: nothing while it simply works.
function browserLine(status: BrowserStatus | null | undefined): string {
  const explained = (problem: string) => (status?.clears ? `${problem} ${status.clears}` : problem);
  if (status?.reason === "keys-locked" && status.problem) return explained(status.problem);
  switch (status?.state) {
    case "off":
      // A computer that is off says so above.
      return status.problem && status.reason !== "computer-stopped"
        ? explained(status.problem)
        : "";
    case "starting":
      return "dot's web browser is starting. This takes a few seconds.";
    case "restarting":
      return "dot's web browser is restarting. Your sign-ins are kept.";
    case "failed":
      return status.retryAt
        ? `${status.problem ?? "dot's web browser couldn't start."} localDot keeps trying.`
        : explained(status.problem ?? "dot's web browser couldn't start.");
    case "stopped":
      return "dot's web browser is stopped.";
    case "ready":
      return status.problem &&
        status.problemAt &&
        Date.now() - Date.parse(status.problemAt) < RECENT_PROBLEM_MS
        ? status.problem
        : "";
    default:
      return "";
  }
}

// The sites with sign-ins in dot's web browser, which keeps them between tasks and restarts.
export function AccountsSection({
  accounts,
  signIn,
  browser,
  report,
}: {
  accounts: AccountsView;
  signIn?: SignInView;
  browser?: BrowserStatusView;
  report?: Pick<ReportControl, "start">;
}) {
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const { phase, sites, pending } = accounts;
  const browserState = browser?.status?.state;
  return (
    <div className="settings-accounts">
      <p className="settings-lede">
        dot's web browser keeps your sign-ins between tasks. A site listed here has saved data,
        though its sign-in may have expired. Passwords you give in a private sign-in form are kept
        separately, and apps in Connectors work without signing in to the website.
      </p>
      {signIn && <SignInToSite signIn={signIn} off={phase === "off"} />}
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
            When you or dot sign in to a site in the web browser, it shows up here.
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
            browser?.failure ??
            (browserLine(browser?.status) ||
              (phase === "starting"
                ? "dot's web browser is starting. This takes a few seconds."
                : ""))}
        </p>
        {browser && (
          <Button
            variant="quiet"
            size="sm"
            busy={
              browser.requesting || browserState === "restarting" || browserState === "starting"
            }
            disabledReason={
              phase === "off" || browser.status?.reason === "computer-stopped"
                ? "Turn on your computer first"
                : browserState === "off"
                  ? "It starts by itself once it can"
                  : undefined
            }
            onClick={browser.restart}
          >
            Restart web browser
          </Button>
        )}
        {report && browserState === "failed" && (
          <Button
            variant="quiet"
            size="sm"
            onClick={(event) => {
              const problem = browser?.status?.problem;
              report.start(event.currentTarget, {
                context: { kind: "browser", ...(problem ? { reason: problem } : {}) },
                title: problem ?? "dot's web browser couldn't start.",
              });
            }}
          >
            Report this problem
          </Button>
        )}
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
