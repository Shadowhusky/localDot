import { CHATGPT_DEVICE_CODE_OFF } from "@localdot/protocol";
import { useState } from "react";
import type { ChatgptControls } from "./useChatgpt.ts";

const failures = {
  unsupported_platform: "ChatGPT support is unavailable on this platform.",
  download_failed: "The download did not finish. Check the connection and retry.",
  integrity_failed:
    "The downloaded runtime did not pass verification. Retry the official download.",
  unsafe_archive:
    "The downloaded archive could not be safely installed. Retry the official download.",
  storage_failed: "The runtime could not be saved. Check available storage and retry.",
  cancelled: "Installation was cancelled. You can install again when ready.",
};
function date(value: number | undefined, seconds = false) {
  if (value === undefined) return "Unknown";
  const time = new Date(seconds ? value * 1000 : value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString() : "Unknown";
}
export function ChatgptPanel({ account }: { account: ChatgptControls }) {
  const [confirm, setConfirm] = useState<"refresh" | "logout" | null>(null);
  const status = account.summary,
    install = status?.install;
  const ready = status?.available && install?.state === "ready";
  const disabled = !!account.busy || account.blocked || !account.verified;
  return (
    <section className="chatgpt-panel role-editor" aria-labelledby="chatgpt-title">
      <h3 id="chatgpt-title">ChatGPT plan</h3>
      {!status && (
        <p>{account.checking ? "Checking ChatGPT support…" : "Account status is unknown."}</p>
      )}
      {status?.available === false && (
        <p>{status.reason ?? "ChatGPT support is unavailable on this computer."}</p>
      )}
      {status?.available && install?.state === "not_installed" && !account.installWatching && (
        <>
          <p>Install ChatGPT support to sign in with your account.</p>
          <button type="button" disabled={disabled} onClick={() => void account.install()}>
            Install ChatGPT support
          </button>
        </>
      )}
      {status?.available && install?.state === "failed" && (
        <>
          <p role="status">{failures[install.code]}</p>
          {install.code !== "unsupported_platform" && (
            <button type="button" disabled={disabled} onClick={() => void account.install()}>
              Retry installation
            </button>
          )}
        </>
      )}
      {account.installWatching && install?.state === "not_installed" && (
        <p role="status">Preparing ChatGPT support installation…</p>
      )}
      {install?.state === "downloading" && (
        <>
          <p>
            Downloading ChatGPT support… {Math.round(install.receivedBytes / 1024)} KiB received
          </p>
          {install.totalBytes === undefined ? (
            <progress aria-label="ChatGPT download progress" />
          ) : (
            <progress
              aria-label="ChatGPT download progress"
              value={install.receivedBytes}
              max={install.totalBytes}
            />
          )}
        </>
      )}
      {install?.state === "verifying" && <p role="status">Verifying ChatGPT support…</p>}
      {install?.state === "ready" && <p>Installed runtime {install.version}</p>}
      {ready && ["signed_out", "expired"].includes(status.state) && (
        <>
          <p>
            {status.state === "expired"
              ? "Your account sign-in expired. Sign in again, then explicitly resume the paused task."
              : "Sign in with your ChatGPT account using a device code."}
          </p>
          {status.state === "signed_out" && account.error !== CHATGPT_DEVICE_CODE_OFF && (
            <p>{CHATGPT_DEVICE_CODE_OFF}</p>
          )}
          <button type="button" disabled={disabled} onClick={() => void account.login()}>
            {status.state === "expired" ? "Sign in again" : "Sign in with code"}
          </button>
        </>
      )}
      <div className="chatgpt-login" hidden={!ready || status?.state !== "signing_in"}>
        <p>
          {account.expired
            ? "The sign-in waiting time ended."
            : "Enter this code on the sign-in page. This panel waits for your account confirmation."}
        </p>
        <label>
          <span>Sign-in code</span>
          <input
            ref={account.code}
            readOnly
            autoComplete="off"
            spellCheck={false}
            aria-label="Sign-in code"
          />
        </label>
        <label>
          <span>Sign-in page</span>
          <input ref={account.link} readOnly autoComplete="off" spellCheck={false} />
        </label>
        <div className="chatgpt-actions">
          <button
            type="button"
            disabled={
              !!account.busy || account.blocked || account.expired || !account.materialReady
            }
            onClick={account.openPage}
          >
            Open sign-in page
          </button>
          <button
            type="button"
            disabled={
              !!account.busy || account.blocked || account.expired || !account.materialReady
            }
            onClick={() => void account.copyCode()}
          >
            Copy code
          </button>
        </div>
      </div>
      {ready && status.state === "signed_in" && (
        <>
          <p>Signed in as {status.account?.email ?? "an account with an unreported identifier"}</p>
          <p>Plan: {status.account?.plan ?? "unknown"}</p>
          <p>Last checked: {date(status.checkedAt)}</p>
          <fieldset className="chatgpt-usage">
            <legend>Account plan usage</legend>
            {(["primary", "secondary"] as const).map((name) => {
              const window = status.usage?.windows.find((row) => row.window === name);
              return (
                <p key={name}>
                  {name === "primary" ? "Primary" : "Secondary"} window:{" "}
                  {window
                    ? `${window.usedPercent}% used${window.windowMinutes === undefined ? "" : ` over ${window.windowMinutes} minutes`}`
                    : "Unknown"}
                  . Reset: {date(window?.resetsAt, true)}
                </p>
              );
            })}
            <p>
              {status.usage
                ? status.usage.limitReached
                  ? "The reported plan limit has been reached. Wait for its reset, then explicitly resume your task."
                  : "No plan limit was reported in the last check."
                : "Current plan limits are unknown."}
            </p>
          </fieldset>
          <div className="chatgpt-actions">
            <button type="button" disabled={disabled} onClick={() => setConfirm("refresh")}>
              Refresh account
            </button>
            <button type="button" disabled={disabled} onClick={() => setConfirm("logout")}>
              Sign out
            </button>
          </div>
        </>
      )}
      {confirm && (
        <div
          className="chatgpt-confirm"
          role="alertdialog"
          aria-labelledby="account-confirm-title"
          aria-describedby="account-confirm-message"
        >
          <h4 id="account-confirm-title">
            {confirm === "logout" ? "Sign out of ChatGPT?" : "Refresh this account?"}
          </h4>
          <p id="account-confirm-message">
            This pauses current ChatGPT work. After the account is ready, use Resume task to
            continue.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const action = confirm;
              setConfirm(null);
              void (action === "logout" ? account.logout() : account.refresh());
            }}
          >
            {confirm === "logout" ? "Pause work and sign out" : "Pause work and refresh"}
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Keep account
          </button>
        </div>
      )}
      {account.canCancelInstall && (
        <button
          type="button"
          disabled={account.blocked || account.busy?.startsWith("cancel_")}
          onClick={() => void account.cancelInstall()}
        >
          Cancel installation
        </button>
      )}
      {account.canCancelLogin && (
        <button
          type="button"
          disabled={account.blocked || account.busy?.startsWith("cancel_")}
          onClick={() => void account.cancelLogin()}
        >
          Cancel sign-in
        </button>
      )}
      {account.busy && (
        <p role="status">
          {account.busy.startsWith("cancel_")
            ? "Cancelling and checking actual status…"
            : "Waiting for the account action…"}
        </p>
      )}
      {account.blocked && (
        <p role="status">Account checks are paused while this view is offline or hidden.</p>
      )}
      {account.error && <p role="alert">{account.error}</p>}
      {account.notice && <p role="status">{account.notice}</p>}
      <button
        type="button"
        disabled={!!account.busy || account.checking || account.blocked}
        onClick={() => void account.check()}
      >
        Check account status
      </button>
    </section>
  );
}
