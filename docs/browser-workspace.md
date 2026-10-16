# Browser workspace

This guide describes the current development UI. Older installed builds may not contain all
of these controls.

For implementation contracts and the comparison with other agents, see
[Agent capability discovery and recovery](agent-runtime.md).

## Two screens for one task

The isolated computer has a **Desktop** and a separate **Web browser**. dot uses the web browser
for anything online: opening a public web page switches the screen to it. The desktop's own
Chromium is for local files and pages served on the desktop itself, such as a site dot is
building on localhost. The label above the live stage identifies the screen receiving the
current actions. Watch follows the latest confirmed screen selection, whichever arrives first
from the task events or live status. Renewing control on the same browser keeps its picture
visible while input waits for fresh status. A browser connection error does not redirect its input to the desktop or open a temporary
browser. Retrying uses the same saved browser profile, so a connection failure does not ask
you to sign in again.

The web browser starts with the computer and stays running between tasks, so switching to it is
immediate. If it is still starting, dot's switch waits for it rather than failing. A web browser
that stops answering, or can no longer be controlled, is started again: at once when dot switches
to it, otherwise within about half a minute. Why a start failed goes to the daemon's log. A local
address such as localhost opens on the desktop, and the screen switches back to it.

## Starting a page and checking the visible result

A new browser may correctly show `about:blank`. Selecting **Web browser** only selects its
screen; it does not navigate to the task's website. dot opens the task URL before diagnosing a
blank-page blocker. Public URLs use the isolated web browser; localhost previews use the
Chromium window on the desktop. Reads and actions target the visible tab, and refuse ambiguous
or changed tab ownership instead of silently choosing a background tab.
An agent page read brings the identified desktop browser window forward if another app covers
it, and checks focus before returning its content. Passive account/page inventory does not
move windows. Stop and user control cancel the reveal along with the read.

The status above the stage follows the selected screen's stream. A hidden desktop stream does
not make a live web browser say **Reconnecting**. Computer lifecycle problems and Stop still
have priority, and their controls continue to operate on the computer.

A readable page establishes navigation, not that an application's interactive flow passed.
dot must perform the requested interactions and inspect their visible result before claiming
that a flow was tested. A confirmed download remains a download even if its optional screenshot
cannot be captured; that failure must not cause dot to start another copy.

Local development HTTPS is supported in the disposable desktop browser, including
Portless URLs such as `https://app.localhost:1355` and nested worktree subdomains.
Its localhost certificate exception does not apply to the browser containing saved
sign-ins or to public websites. Navigation errors distinguish certificates, stopped
servers, DNS and genuinely unsafe ports. See [Local development previews](local-development-previews.md)
for the policy, incident diagnosis, comparison sources and regression checks.

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
account and password, and submits a same-origin POST form or a recognized JavaScript sign-in
button in one operation. Staged password pages can use Next or Continue; recognition is based on
form structure and field metadata, not a particular website. Ordinary model
clicks and typing still cannot enter a password field. The model sees the result, never the
password, and credentials are excluded from conversation events.

For a CLI device login you requested, dot can enter the pairing code that the CLI itself
prints, using the same private channel in the visible browser. It keeps that CLI process alive,
completes the requested authorization and checks the CLI's sign-in status. This does not share
connector credentials with the CLI. Passwords and codes from your authenticator, phone or email
still use private user input.

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

Private invitation, early-access and activation codes also use the private conversation form.
Clearly labelled ordinary room/referral/public-share codes stay ordinary input. A normal
text input can still contain a private code: localDot recognizes these fields from their own
metadata and protects them from page reads and recordings. Unknown-length codes use one pasteable
field; a fixed number of boxes is shown only when the page specifies the length. Codes are not
saved in task memory or over an existing password. The browser keeps the resulting session.
If the page opened in desktop Chromium, dot opens it in the managed browser before requesting the
code. A missing code alone is not a reason to hand over the computer.

App testing should open the app's preview on the streamed computer and exercise its visible flows. Command-line tests supplement that view. What dot knows refreshes while Settings is open; lasting user-provided facts are saved separately from recent task history, without credentials or transient task details.

The same structured input flow handles missing account details, rejected passwords, verification
codes, choices, confirmations, dates, numbers, files, and device handoffs. On supported
username-first pages, `ask_user` with `purpose: "sign_in"` can resolve the saved account after
the account field is focused. A saved password is not requested again just because the account
name is missing. If the local vault cannot be reached, the tool reports that problem instead
of treating it as an empty vault. Recovery/backup codes and PIN fields use the same masking and
private-delivery classification as other verification codes. These are not reusable passwords.

Stored cookies do not prove that a website is still signed in, and connector credentials do not
create a website login. Check the existing page or connected tool first. CAPTCHA, physical security
keys, device approval, and forms outside the verified private-input path still need an explicit
handoff. The agent should explain the step, keep the page open, and inspect the result after
control returns instead of restarting the browser or repeating the same failed submission.

## Graphics on macOS

The visible web browser runs inside Docker's Linux VM. Docker Desktop on macOS does not expose
the Mac GPU to these containers; the browser uses software graphics. Removing a Chromium flag
cannot enable hardware acceleration without a different host/runtime. Do not diagnose a black
capture or a browser restart as a GPU failure without checking the input and renderer errors first.

Website interaction belongs in the visible web browser, including games and pages without
sign-in. A control failure should trigger a bounded retry after recovery, then a clear explanation
if it persists, rather than a hidden browser or a second desktop Chromium session.

## Distinguishing private input from ordinary codes

The board-game failure in run `01M4V4XAD570T55B6Z4PRH28QX` was a false positive:
the requested room link populated a text field named `invite-code`, labelled `房间码`
(room code), with `autocomplete=off`. The old invite/access-code regex classified the
room code as a credential. The filled-secret guard then refused navigation's observation,
page reads and screenshots; the agent incorrectly described ordinary prefilled game state
as private input needing a user handoff.

Code classification now considers the field's purpose. Password types, password/OTP
autocomplete and explicit authentication/access/activation evidence retain priority.
Clear room/lobby/game/table invitation semantics can disambiguate a generic invitation
identifier, including English and Chinese labels. Unknown invitation fields remain protected;
there is no domain allowlist or page-text instruction that switches protection off. All
editable values still receive the existing text/AX exclusion and screenshot masking.

The remaining genuine-secret guard is deliberate: allowing a masked read alone is not proof
that raw recording is safe, or that a page has not reflected a credential elsewhere. This
change does not remove that guard, change the private entry channel, or silently clear/reload
an ordinary game field. Classification is deterministic and testable; it is not a claim that
an LLM can perfectly infer whether every arbitrary page field is sensitive.

The design was checked against current primary documentation:

- [OpenAI Computer Use safety guidance](https://learn.chatgpt.com/docs/computer-use#safety-guidance)
  describes user oversight for sensitive flows and target-specific control.
- [Anthropic browser-use security considerations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool#security-considerations)
  recommend isolation, limiting credentials, visible-page observations and human confirmation
  for consequential actions.
- [Browser Use credential handling](https://browser-use.com/enterprise) describes model-visible
  placeholders with credentials supplied privately and scoped to domains.

These sources support keeping secrets separate from model observations. They do not establish
that every invite/room code should block an entire page, nor do they disclose the full internal
classifiers of closed-source products. The concrete behavior here is validated by local
positive and negative regression cases rather than a claim of equivalence to those products.

Verification for this change: 371 tests passed across 8 combined browser protection suites,
including composed observation/control regressions; browserd typecheck, scoped Biome and
`git diff --check` passed. The `localdot/browser:dev` image was rebuilt successfully.
Activation waited until every game run ended and no live/manual-control session remained,
as requested. The supported daemon restart activated the rebuilt browser image on 13 October.
Live verification `01M4V7FKQJJ6WT274Z1740HFQQ` then filled the game's room-code field with
synthetic `ABC123`, successfully read and captured the page while filled, and cleared it.
No room was joined or created and no game moves were made. The same test exercised an
interruptible completion wait followed by a fresh page read. The temporary activation
heartbeat was disabled after activation.

Current limits: the public-purpose exception reads the field's own `aria-label` and
`placeholder`, with English and Chinese patterns. Other languages or an external `<label>`
alone can still leave a generic invitation field classified as private. This is a tested
correction to the deterministic classifier, not a replacement for the entire privacy system.
