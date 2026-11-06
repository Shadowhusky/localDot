# Browser workspace

This guide describes the current development UI. Older installed builds may not contain all
of these controls.

For implementation contracts and the comparison with other agents, see
[Agent capability discovery and recovery](agent-runtime.md).

## One screen for one task

The isolated computer shows one screen. Underneath it has a **desktop** and a separate **web
browser**, each in its own container with its own stream, and the stage draws the browser as a
window on the desktop: under the desktop's menu bar, as large as its shape allows, with a slim margin
of desktop each side. dot uses the web browser for anything online: opening a public web page brings
that window forward. The desktop's own Chromium is for local files and pages served on the desktop
itself, such as a site dot is building on localhost.

The window follows dot: it comes forward when dot works in the web browser and goes back when dot
works on the desktop, by the latest confirmed screen selection, whichever arrives first from the task
events or live status. There is no switch between the two. The desktop's menu bar has a **Web
browser** entry, as a taskbar does, that minimises the window or shows it again; what you choose
holds until dot next moves or you hand the computer back. Behind the desktop the window is wholly
covered, so the entry is how to bring it back. Renewing control on the same browser keeps its picture
visible while input waits for fresh status. A browser connection error does not redirect its input to the desktop or open a
temporary browser. Retrying uses the same saved browser profile, so a connection failure does not ask
you to sign in again.

While you hold the computer, input goes to what is under your pointer: the window to the browser and
the menu bar above it to the desktop. A click on the menu bar brings the desktop forward once it lets
go, and so does a click on the desktop in a margin beside the window, which goes no further, as a
click on a window behind does. Keys go to whichever is in front. On a phone the menu bar and margins
are too thin to aim at, so they take no taps, and the entry is a round button hanging from the bar.
dot's own screen doesn't change with what you bring forward: its screenshots and coordinates stay that screen's own. Reaching the browser
while dot is on the desktop takes it for you at your first input there, as a takeover on the browser
does, and the next task to use it starts by clearing your selections and reloading pages holding
secrets.

Some things stay apart, because the browser's sign-ins depend on it: nothing can be dragged between
the browser and a desktop app (a drag stops at the edge of its own side), the two don't stack with
each other (one or the other is in front), and text copied on one side can't be pasted on the other.
The app says so the first time you cross over or drag past the edge. [The design](superpowers/specs/2026-11-04-parallel-browser-windows.md#phase-3-one-screen)
says why, and what it costs.

The web browser starts with the computer and stays running between tasks, so switching to it is
immediate. If it is still starting, dot's switch waits for it rather than failing. A local address
such as localhost opens on the desktop, and the screen switches back to it.

A new conversation's task first sees the web browser on a blank tab; the page the task before it
left stays open, as it was, in a tab behind. A task that continues a conversation carries on from
the page in front. Opening the blank tab reuses one already open, closes any other blank tab, and
keeps at most four tabs in its window, closing the oldest.

Several tasks can use the web browser at once, in the same signed-in sites. It stays one browser
with one profile, and each task has its own window, so signing out in one task signs out both. A
task can only see and act in its own window. Tasks act in turns, a moment each, and the stage shows
whichever task acted last; a task's window keeps working behind the others, and a page loading holds
nobody up. What a task copied does not survive another task's turn, and a menu that closes when its
window loses focus closes then too. **Sign in without agent control** and restarting the browser
relaunch it for everyone: the other tasks wait, then hear that their window was closed and open their
page again. Replay shows each task only its own window, with the time another task was on screen
marked.

The web browser recovers by itself and always keeps its saved sign-ins. A tab whose page crashes
(for example, out of memory) is reloaded, up to three times a minute. If Chromium itself exits,
hangs or loses its control connection, its container restarts it in place within a few seconds,
blank, at most three times in five minutes; past that, or if the container stops answering, the
daemon starts a new browser within about ten seconds. dot is told what happened and can restart a
stuck browser itself (`switch_screen` with `restart: true`, once a minute). **Settings → Accounts**
shows what last went wrong and has **Restart web browser**; `localdot browser status` and
`localdot browser restart` do the same from a terminal. Each failure's reason (exit status, an
out-of-memory kill, what browserd last said) goes to the daemon's log.

The web browser is called available only while it runs. Otherwise Settings, the terminal and dot
are told why (the key service is offline, the computer is stopped or frozen, localDot is still
confirming that the previous browser stopped, it is starting, or it failed and with what), what
clears it and when localDot tries again; dot gets a note once the browser runs again, so it waits
instead of retrying. A failed start is tried again five times over about two minutes; then localDot
stops, tells dot, and waits for **Restart web browser**, the computer or the key service to give it
another round. Locked saved keys don't stop the web browser: it browses with its sign-ins, but saved
passwords and sites that use a saved key are refused until you unlock them in **Keys**.

## Starting a page and checking the visible result

A new browser may correctly show `about:blank`. Selecting **Web browser** only selects its
screen; it does not navigate to the task's website. dot opens the task URL before diagnosing a
blank-page blocker. Public URLs use the isolated web browser; localhost previews use the
Chromium window on the desktop. Reads and actions target the visible tab, and refuse ambiguous
or changed tab ownership instead of silently choosing a background tab.
An agent page read brings the identified desktop browser window forward if another app covers
it, and checks focus before returning its content. Passive account/page inventory does not
move windows. Stop and user control cancel the reveal along with the read.

The status above the stage follows the stream of what is in front. A hidden desktop stream does
not make a live web browser say **Reconnecting**. Computer lifecycle problems and Stop still
have priority, and their controls continue to operate on the computer.

**Connecting your screen** covers the stage only until a page has shown the computer's picture
since the computer last came up. After that, any gap keeps the last picture on the stage, dimmed:
under a second shows nothing, then a word in the middle of the picture says what is happening
(**Reconnecting…**, **Switching to the web browser…**, **The web browser is restarting…**), and
after ten seconds it says more and offers **Try again**, which asks for a fresh stream at once.
A paused computer, Replay and a hidden tab say why themselves and start that clock afresh. Only
what lasts is announced; the HUD and the screen toast already say a gap and a switch.

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
it does not delete the saved password in keyd.

### Saved logins

**Settings → Keys → Saved logins** lists each saved login by site and account, with Add, Edit and
Remove. A password is never shown again: Edit changes the account, or replaces the password if you
type a new one. What you enter is sealed in the page to keyd, so the daemon relays ciphertext.

**Import** takes a CSV export from Chrome, 1Password, Bitwarden or Apple Passwords (other managers
with the usual column names work too), up to 4 MiB and 3,000 logins. The whole file is sealed in the
page and only keyd reads it. It keeps each login's site, account and password and drops the rest,
keeps a login already saved for a site, and answers in counts and line numbers, never a cell. Nothing
stores the file, so delete your copy: the app says so before and after. One login is kept per site, so
a second account for a site is left out and counted. HTTP sites and app addresses are left out too.

A login added here or imported is filled only after your tap, once a task: dot's `ask_user` for a
password shows **Sign in**, naming the site and nothing about the account. While you hold the web
browser, the panel under the screen offers **Sign in as …** on a site with a saved login, covering a
page that asks for the account first. A password you gave dot in a private form on that very site
is still reused without a tap, as before; saved again in Settings or imported over, it starts to ask.
Only the owner's tap counts: a shared link's guest is refused.

A login fills on its own exact origin, on that origin's `www` twin, and for a site in
`KNOWN_SIGN_INS` on the sign-in hosts listed there. The twin and listed hosts always take a tap. Any
other subdomain or lookalike is another site: nothing is offered and no password leaves keyd. browserd
checks the page's real origin before every character, so a page that navigates away mid-fill gets
no more of it. Saved logins can't be filled in sign-in mode, because nothing is connected to the page
to check which site it is; type or paste there.

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

Google's sign-in page goes straight to **Sign in without agent control** when you hold the browser
there, and dot is told to hand over rather than type into it, so the "This browser or app may not be
secure" error doesn't come first. See [Browser environment](browser-environment.md).

Passkeys and security keys can't finish in this browser: its container has no Bluetooth, USB or device
authenticator. Choose the site's password or code option; if it has none, you can say so to dot. See
[Browser environment](browser-environment.md) for what was measured.

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
in-flight work to drain before a new conversation can take ownership. Messages dot had not acted
on yet go back into your composer and leave the conversation. It does not leave a paused
task holding the computer, shut down the desktop, or discard its browser. The next conversation reuses that computer. Sending a message during user control hands control back and steers the task immediately. The CLI emergency Stop and Stop computer remain separate controls. Do not treat an
interrupted upload or release as proof that the receiving side saw no bytes.

Replay records the desktop and the web browser each on its own track while the agent is working,
including when you are not watching. Choose one in Replay to inspect or export that track; the window
on the live screen is drawn by the page and isn't recorded as such. Manual-control gaps stay private.
See [the Replay guide](replay.md) for retention, export and recovery details.

## Account reuse and verification

Connected apps and saved browser accounts are used before requesting another sign-in. A connector's authentication does not log a separate command-line client in: dot should use the connected tools for supported work and the existing browser account for website work, and explain any missing capability before asking for additional access.

On a phone, the code's field offers the text message's code, **Paste code** reads what you copied, and
a code of known length that is the whole question goes as soon as it is whole.

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
