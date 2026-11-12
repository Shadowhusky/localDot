import { CHATGPT_DEVICE_CODE_OFF } from "@localdot/protocol";
import { useRef, useState } from "react";
import { limitName } from "../agent/plan-usage.ts";
import { resetTime } from "../agent/UsageFooter.tsx";
import { t } from "../i18n/index.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { Meter } from "../ui/Meter.tsx";
import { MiddleTruncate, tailOf } from "../ui/MiddleTruncate.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Progress } from "../ui/Progress.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { chatgptSteps, megabytes } from "./chatgpt-steps.ts";
import type { ChatgptControls } from "./useChatgpt.ts";

function checkedAt(value: number | undefined): string {
  const time = value === undefined ? undefined : new Date(value);
  return time && Number.isFinite(time.getTime())
    ? t`Checked ${time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : t`Not checked yet`;
}

export function ChatgptPanel({ account, id }: { account: ChatgptControls; id?: string }) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<"refresh" | "logout" | null>(null);
  const status = account.summary;
  const install = status?.install;
  const ready = status?.available === true && install?.state === "ready";
  const checked = ready && status.sandbox === "passed";
  const signingIn = checked && status.state === "signing_in";
  const signedIn = checked && status.state === "signed_in";
  const refused = account.error === CHATGPT_DEVICE_CODE_OFF;
  const copied = account.notice === t`Sign-in code copied.`;
  const waitReason = account.blocked
    ? t`Paused while this page is hidden`
    : !account.verified
      ? t`Checking the account first`
      : account.busy
        ? t`Wait for the current step to finish`
        : undefined;
  // The button that started a step shows it working; the others say why they wait.
  const press = (action: NonNullable<ChatgptControls["busy"]>) =>
    account.busy === action ? { busy: true } : { disabledReason: waitReason };
  const cancelReason =
    account.blocked || account.busy?.startsWith("cancel_") ? t`Cancelling…` : undefined;
  return (
    <section id={id} className="settings-chatgpt" aria-labelledby="chatgpt-title">
      <header className="settings-card-head">
        <div>
          <h4 id="chatgpt-title" className="settings-card-title">
            {t`ChatGPT plan`}
          </h4>
          <p className="settings-card-note">
            {t`The main model runs on the ChatGPT account signed in on this dot. Each of your dots signs in on its own.`}
          </p>
        </div>
        <IconButton
          ref={more}
          label={t`Account actions`}
          icon="more-horizontal"
          {...triggerProps("menu", menu)}
          onClick={() => setMenu(true)}
        />
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          anchor={more}
          align="end"
          label={t`Account`}
        >
          <MenuItem
            disabledReason={
              account.busy || account.checking || account.blocked
                ? t`Wait for the current step to finish`
                : undefined
            }
            onSelect={() => void account.check()}
          >
            {t`Check account status`}
          </MenuItem>
          {signedIn && (
            <MenuItem disabledReason={waitReason} onSelect={() => setConfirm("refresh")}>
              {t`Refresh account`}
            </MenuItem>
          )}
          {signedIn && (
            <MenuItem disabledReason={waitReason} onSelect={() => setConfirm("logout")}>
              {t`Sign out`}
            </MenuItem>
          )}
        </Menu>
      </header>

      {!status && (
        <p className="settings-note">
          {account.checking ? t`Checking ChatGPT support…` : t`Account status is unknown.`}
        </p>
      )}
      {status?.available === false && (
        <p className="settings-note">
          {status.reason ?? t`ChatGPT support is unavailable on this computer.`}
        </p>
      )}

      {status?.available && !signedIn && (
        <ol className="settings-steps" aria-label={t`Setup`}>
          {chatgptSteps(status, account.installWatching).map((step) => (
            <li key={step.id} className="settings-step" data-state={step.state}>
              <StatusGlyph state={step.state} className="settings-step-glyph" />
              <span className="settings-step-text">
                <span className="settings-step-name">{step.title}</span>
                <span className="settings-step-detail">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {(install?.state === "downloading" || install?.state === "verifying") && (
        <Progress
          label={t`ChatGPT download progress`}
          {...(install.state === "downloading" && install.totalBytes !== undefined
            ? {
                value: install.receivedBytes,
                max: install.totalBytes,
                valueText: t`${megabytes(install.receivedBytes)} of ${megabytes(install.totalBytes)}`,
              }
            : {})}
        />
      )}
      {status?.available && install?.state === "not_installed" && !account.installWatching && (
        <div className="settings-actions">
          <Button variant="primary" {...press("install")} onClick={() => void account.install()}>
            {t`Install ChatGPT support`}
          </Button>
        </div>
      )}
      {status?.available &&
        install?.state === "failed" &&
        install.code !== "unsupported_platform" && (
          <div className="settings-actions">
            <Button {...press("install")} onClick={() => void account.install()}>
              {t`Try again`}
            </Button>
          </div>
        )}
      {ready && status.sandbox === "failed" && (
        <div className="settings-actions">
          <Button variant="primary" {...press("check")} onClick={() => void account.checkSandbox()}>
            {t`Check again`}
          </Button>
        </div>
      )}
      {/* Sign-in comes next: it waits in its place while the check runs. */}
      {ready && (status.sandbox === "checking" || status.sandbox === "unchecked") && (
        <div className="settings-actions">
          <Button variant="primary" disabledReason={t`Wait for the safety check to finish`}>
            {t`Sign in with code`}
          </Button>
        </div>
      )}
      {account.canCancelInstall && (
        <div className="settings-actions">
          <Button
            variant="quiet"
            disabledReason={cancelReason}
            onClick={() => void account.cancelInstall()}
          >
            {t`Cancel installation`}
          </Button>
        </div>
      )}

      {checked && (status.state === "signed_out" || status.state === "expired") && (
        <>
          {status.state === "expired" && (
            <p className="settings-note">{t`Sign in again, then resume the paused task.`}</p>
          )}
          {status.state === "signed_out" && (
            // The same line in the same place when a code start is refused, so nothing moves; the
            // new key makes it a fresh alert that screen readers announce.
            <p
              key={refused ? "refused" : "hint"}
              role={refused ? "alert" : undefined}
              className="settings-hint"
              data-alert={refused ? "" : undefined}
            >
              <Icon name="circle-alert" size={12} />
              <span>{CHATGPT_DEVICE_CODE_OFF}</span>
            </p>
          )}
          <div className="settings-actions">
            <Button variant="primary" {...press("login")} onClick={() => void account.login()}>
              {status.state === "expired" ? t`Sign in again` : t`Sign in with code`}
            </Button>
            {account.canCancelLogin && (
              <Button
                variant="quiet"
                disabledReason={cancelReason}
                onClick={() => void account.cancelLogin()}
              >
                {t`Cancel sign-in`}
              </Button>
            )}
          </div>
        </>
      )}

      {/* Always mounted, so the code and the page address stay only in these two fields. */}
      <div className="settings-signin" hidden={!signingIn}>
        <p className="settings-note">
          {account.expired
            ? t`The code ran out of time. Cancel, then sign in again.`
            : t`Enter this code on the sign-in page. This panel waits for your account.`}
        </p>
        <Field label={t`Sign-in code`}>
          <TextField
            ref={account.code}
            code
            readOnly
            autoComplete="off"
            spellCheck={false}
            suffix={
              <IconButton
                label={copied ? t`Code copied` : t`Copy code`}
                icon={copied ? "check" : "copy"}
                size={28}
                disabledReason={
                  account.expired || !account.materialReady ? t`No code to copy yet` : waitReason
                }
                onClick={() => void account.copyCode()}
              />
            }
          />
        </Field>
        <Field label={t`Sign-in page`}>
          <TextField ref={account.link} readOnly autoComplete="off" spellCheck={false} />
        </Field>
        <div className="settings-actions">
          <Button
            variant="primary"
            disabledReason={
              account.expired || !account.materialReady ? t`The code isn't ready` : waitReason
            }
            onClick={account.openPage}
          >
            {t`Open sign-in page`}
          </Button>
          {signingIn && account.canCancelLogin && (
            <Button
              variant="quiet"
              disabledReason={cancelReason}
              onClick={() => void account.cancelLogin()}
            >
              {t`Cancel sign-in`}
            </Button>
          )}
        </div>
      </div>

      {signedIn && <SignedIn account={account} />}

      <div
        className={
          copied && !account.error && !account.blocked && !account.busy?.startsWith("cancel_")
            ? "ui-visually-hidden"
            : "settings-messages"
        }
      >
        {account.error && !refused && (
          <p role="alert" className="settings-error">
            <Icon name="circle-alert" size={12} />
            <span>{account.error}</span>
          </p>
        )}
        {account.busy?.startsWith("cancel_") && (
          <p role="status" className="settings-note">
            {t`Cancelling and checking where things stand…`}
          </p>
        )}
        {account.blocked && (
          <p role="status" className="settings-note">
            {t`Account checks wait while this page is hidden.`}
          </p>
        )}
        {account.notice && (
          <p role="status" className={copied ? "ui-visually-hidden" : "settings-note"}>
            {account.notice}
          </p>
        )}
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        anchor={more}
        title={confirm === "logout" ? t`Sign out of ChatGPT?` : t`Refresh this account?`}
        description={t`This pauses current ChatGPT work. When the account is ready, press Continue on the computer.`}
      >
        <Button onClick={() => setConfirm(null)}>{t`Keep account`}</Button>
        <Button
          disabledReason={waitReason}
          onClick={() => {
            const action = confirm;
            setConfirm(null);
            void (action === "logout" ? account.logout() : account.refresh());
          }}
        >
          {confirm === "logout" ? t`Pause work and sign out` : t`Pause work and refresh`}
        </Button>
      </Dialog>
    </section>
  );
}

function SignedIn({ account }: { account: ChatgptControls }) {
  const status = account.summary;
  if (!status) return null;
  const email = status.account?.email;
  const plan = status.account?.plan;
  const signedInAs = email ? t`Signed in as ${email} on this dot` : "";
  return (
    <div className="settings-account">
      <div className="settings-account-row">
        <span className="settings-monogram" aria-hidden="true">
          {(email ?? "?").charAt(0).toUpperCase()}
        </span>
        <span className="settings-account-text">
          <span className="settings-account-email">
            {email ? (
              <MiddleTruncate
                text={signedInAs}
                tail={
                  tailOf(email) + signedInAs.length - (signedInAs.lastIndexOf(email) + email.length)
                }
              />
            ) : (
              t`Signed in on this dot`
            )}
          </span>
          <span className="settings-note">{checkedAt(status.checkedAt)}</span>
        </span>
        {plan && <Badge>{`${plan.charAt(0).toUpperCase()}${plan.slice(1)}`}</Badge>}
      </div>
      {(["primary", "secondary"] as const).map((name) => {
        const window = status.usage?.windows.find((row) => row.window === name);
        const fallback = name === "primary" ? t`Short limit` : t`Long limit`;
        if (!window)
          return (
            <p key={name} className="settings-note">
              {name === "primary" ? t`Short limit: not reported` : t`Long limit: not reported`}
            </p>
          );
        const reset = resetTime(window.resetsAt);
        return (
          <Meter
            key={name}
            label={[limitName(window.windowMinutes, fallback), reset].filter(Boolean).join(" · ")}
            value={window.usedPercent}
            valueText={t`${Math.round(window.usedPercent)}% used`}
          />
        );
      })}
      <p className="settings-note">
        {status.usage
          ? status.usage.limitReached
            ? t`The plan's limit is reached. Wait for it to reset, then resume your task.`
            : t`No limit reached at the last check.`
          : t`The plan's limits aren't known yet.`}
      </p>
    </div>
  );
}
