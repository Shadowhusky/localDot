# Browser workspace

This guide describes the current development UI. Older installed builds may not contain all
of these controls.

## Two screens for one task

The isolated computer has a **Desktop** and a separate **Web browser**. dot uses the web browser
for anything online: opening a public web page switches the screen to it. The desktop's own
Chromium is for local files and pages served on the desktop itself, such as a site dot is
building on localhost. The label above the live stage identifies the screen receiving the
current actions. A browser connection error does not redirect its input to the desktop.

The web browser starts with the computer and stays running between tasks, so switching to it is
immediate. If it is still starting, dot's switch waits for it rather than failing. A web browser
that stops answering, or can no longer be controlled, is started again: at once when dot switches
to it, otherwise within about half a minute. Why a start failed goes to the daemon's log. A local
address such as localhost opens on the desktop, and the screen switches back to it.

## Sign in once

Sign-ins live in one browser profile that belongs to you, not to a computer. It is kept when the
browser or the computer restarts, between tasks and conversations, after the daemon restarts and
after **Replace computer**. Only one web browser at a time opens it. The desktop never sees it:
the profile is a separate Docker volume that only the browser cell mounts, the browser's
DevTools connection is a private pipe inside its own container, and the two cells share no
network. Programs dot runs on the desktop cannot read its cookies or site data. The volume is
named after the daemon's home folder, so a second localDot install on the same Docker engine
gets its own.

When upgrading, the computer's existing browser profile is copied into the shared one the first
time the web browser starts (or before **Replace computer** would delete it). If several
computers each had a profile, the current computer's profile is used.

To sign in yourself, open **Settings → Accounts** and use **Sign in to a site**: type a site such
as google.com, or pick a common one. The web browser opens that site's sign-in page and you are in
control there; hand the computer back when you are done, and the site appears in the list. dot
uses the protected sign-in flow below, only in the web browser.

When dot asks for an account and password in chat, the daemon delivers them through a private
browser input channel. For a supported HTTPS sign-in, it verifies the password field, fills the
account and password, and submits the same-origin POST form in one operation. Ordinary model
clicks and typing still cannot enter a password field. The model sees the result, never the
password, and credentials are excluded from conversation events.

Supported logins are saved in keyd's protected store (Keychain, keyring or encrypted file,
depending on the installation), bound to the exact HTTPS origin. One account is saved per origin;
a later answer replaces it. A future task can reuse it once before asking for updated credentials
if the site rejects it. A rejected password opens another private answer prompt: dot keeps control,
asks for the corrected account/password, and replaces the saved login. It never silently replays
a password already delivered in that task. Retry forms may keep their submit button disabled until
a new password is entered; dot verifies it is enabled before submitting. The browser’s separate
password-save popup is disabled because keyd handles saving. Account suggestions are dismissed
before dot checks and focuses the password field again.

Two-factor authentication, security challenges and forms the protected
path cannot verify may require your input or a clearly explained takeover.

Saved passwords and browser cookies are separate. **Sign out** clears browser sign-in state;
it does not delete the saved password in keyd. There is not yet a saved-password management UI.

**Settings → Accounts** lists the sites with stored sign-ins, grouped by site, with **Sign out**
for one site (its cookies, including partitioned ones, and the saved data of the hosts they were
set for) and **Sign out of all sites**, which restarts the web browser with an empty profile and
deletes the profiles computers kept before sign-ins were shared. A site that keeps a sign-in only
in the saved data of another subdomain can still remember you after **Sign out**; Settings says
so when the site is still listed, and **Sign out of all sites** removes everything.

The desktop's own Chromium opens on a page saying sign-ins there aren't kept; only a window opened
without an address shows it, and a new tab shows Chromium's usual new-tab page. A site typed into
that page, or a sign-in page you reach there while you hold the computer, brings a notice in
localDot offering to open the site in the web browser; nothing opens until you choose it, and the
daemon opens only the named site's sign-in or home page. During a task, the notice says to ask
dot instead.

Links that a desktop app opens (a link in a document, `xdg-open` in the terminal) still open in
the desktop's Chromium, which has none of your sign-ins; dot opens such an address again in the
web browser when it needs them. They are not moved to the web browser automatically, because any
program on the desktop could then steer the web browser that holds your sign-ins, and switching
screens while dot works could send its next click to the wrong screen.

## Signing in and returning control

When the task requests manual control, wait until the controls are available, then type and
click straight into the live computer. Complete sign-in or verification, then choose **Return
control to dot**. The sign-in stays for later tasks. The optional hand-back
note is part of the task, so put instructions there rather than passwords or verification codes.

Takeover intervals are excluded from task recording. The browser also protects private form
fields from agent observations. These protections do not prevent a website from displaying
account information after sign-in; decide which sites the task should use.

## Downloads

Downloads first appear in **Activity → Browser downloads**. They remain in quarantine until
you choose **Review & release**, inspect the filename, size, source and SHA-256 digest, and
confirm **Release once**. The destination is the isolated computer's Downloads folder. Releasing
a file does not open it, run it or extract an archive.

Choose **Discard** for a file you do not want. If a release reply is interrupted, use **Check
delivery** to reconcile the earlier placement. It does not create a second copy. A changed file
or digest requires a new review. **Refresh downloads** reloads the current list.

The current limits are 1 GiB per download and 10 GiB total quarantine storage. Unreleased files
expire after seven days. The managed browser disables Chromium's automatic download popup so
it does not cover the page; localDot's review panel remains the place to release files.

## Uploads

Ask dot to open the website's file chooser and select a file from the isolated computer. The
upload approval names every file, its path, size and SHA-256, along with the receiving page's
origin. Approving binds those exact bytes to that chooser and page. The total upload limit is
100 MiB. A changed file, closed chooser, page navigation or expired task requires a fresh action
and approval.

The receiving origin is the page that gets the file object. Its JavaScript may then send the
file elsewhere. The upload action assigns files to the chooser; the site's submit action is a
separate interaction.

## Stop, replay and recovery

**Stop task** cancels the run and its queued messages, withdraws agent control and waits for
in-flight work to drain before a new conversation can take ownership. It does not leave a paused
task holding the computer, shut down the desktop, or discard its browser. The next conversation reuses that computer. Sending a message during user control hands control back and steers the task immediately. The CLI emergency Stop and Stop computer remain separate controls. Do not treat an
interrupted upload or release as proof that the receiving side saw no bytes.

Replay records both screens while the agent is working, including when you are not watching.
Choose a screen in Replay to inspect or export that track. Manual-control gaps stay private.
See [the Replay guide](replay.md) for retention, export and recovery details.

## Account reuse and verification

Connected apps and saved browser accounts are used before requesting another sign-in. A connector's authentication does not log a separate command-line client in: dot should use the connected tools for supported work and the existing browser account for website work, and explain any missing capability before asking for additional access.

An empty, focused password or verification field no longer hides the page from dot. Filled secrets remain excluded from page reads and screenshots. One-time codes use the private answer channel, are submitted to the identified verification field once, and are never saved as passwords or included in the conversation. Dot keeps the verification page open and explains whether the code comes from an authenticator, email or SMS.

App testing should open the app's preview on the streamed computer and exercise its visible flows. Command-line tests supplement that view. What dot knows refreshes while Settings is open; lasting user-provided facts are saved separately from recent task history, without credentials or transient task details.
