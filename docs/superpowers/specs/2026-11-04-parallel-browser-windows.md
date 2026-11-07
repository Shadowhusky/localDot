# Several tasks in one web browser — phase 1

Status: built on `qa10/parallel`. The owner approved the design. [Phase 3](#phase-3-one-screen),
below, composites the browser onto the main screen. The mechanism is exercised against a real browser
cell by `apps/daemon/src/cells/browserd-windows.docker.test.ts`.

## Problem

A task told the user: "The browser signed in to Linear is busy with your other running task, so I
can't open THE-2187." One task at a time held the web browser for as long as it stayed there, though
the computer's lease is per action, and a second task fell back to a browser with no sign-ins.

## Decision

One browser process and one profile, with one window per task.

- **Sign-ins are shared.** Signing out in one task signs out both. The owner accepted this.
- **Permits are per task and stop at its windows.** Every browser request is checked against the
  task's own grant and the tab's window. A task's windows are the one it was given and those its pages
  open.
- **Actions stay serialized on the computer's one lease lane.** Input, the screenshot's root grab and
  the active-window check all need the display. A turn raises the task's window and checks it first.
- **No "browser busy" refusal, and no fallback to a browser without sign-ins.** Removed:
  `claimBrowser`, `makeWay`, `BrowserInUseError`.
- **The stage follows the task on screen.** The stream is the display. Other tasks keep working in
  their windows.

## Verified assumptions

Measured on Chromium 154 under Xvfb and xfwm4, on the same flags as the cell.

- **Windows aren't free of throttling by themselves.** A covered window reports
  `visibilityState: hidden`, runs timers at 1 Hz and gets no animation frames, the same as a background
  tab. `--disable-backgrounding-occluded-windows` keeps it visible and at full rate. A background tab
  inside a window stays throttled, so windows plus the flag are what make tasks independent.
- **AT-SPI reads the right window with several open.** The active frame's document and URL come back
  correctly, and an inactive window reads as null. A second window made reads no slower that could be
  told. Under a host load above about 60, the read's 0.9 second budget runs out with one window too (7
  of 25 reads succeeded), and actions are refused.
- **Keyboard focus comes back with the window.** Typing after a re-raise lands in the same field.
- **A window costs about 100 MiB.** Cell memory grew by 86 to 107 MiB for a second window at scale 2,
  blank or with a small page, against about 24 MiB for a small page in another tab.
- **An address doesn't identify a window.** Two tasks can show the same URL, so the URL check can't
  tell them apart, and Chromium's window id names no X window. The registry binds each to the other
  when first seen, and every read requires the active X window to be the bound one.
- **`Target.createTarget` opens in the active window**, so a task's new tab lands in its own window
  while its turn has the display.
- **`openerId` is set for popups and `target=_blank`;** a download's `frameId` and a frame's `parentId`
  name their tab.

Menus across another task's turn:

| Menu | Survives? |
| --- | --- |
| DOM menu closed by a click elsewhere | yes |
| DOM menu closed on window blur | no |
| `<select>` popup | no |
| Native context menu | no |

Chromium closes these itself and nothing can keep them open. The gateway's existing check that a
target still matches the model's screenshot should refuse a click on a closed menu as stale, with a
fresh look; that path was read, not exercised. The pointer is put back where the task left it, so a
hover can come back.

## Mechanism

**browserd.** `BrowserControl` holds a grant per task. A task's request reaches only its grant and
actions. `holder: "user"` still revokes everyone, drains and raises the window the user takes.
Leaving the user's control still clears selections and reloads pages holding secrets, whichever task
asks first. `BrowserWindows` (`windows.ts`) owns the task-to-window map: assignment, X binding, popups
by opener, the raise, and closing finished tasks' windows beyond two.

Assignment, in order: the window the task already has, the one it left, the one of the conversation it
continues, a finished task's window for a new conversation (behind its blank tab, as when alone), else
a new window. A task that was already at work never lands on another task's page.

Each raise saves the previous task's pointer, clears X selections so copied text can't cross tasks,
activates the window, waits for a good accessibility read and restores this task's pointer. Nothing
moves for a task alone, so a lone task sends no extra native commands.

**A slow page doesn't hold the lane.** `browser_navigate` gives up its turn during the load, and
`POST /navigate` needs no display. `Page.navigate` may take the full navigation deadline: Chromium
answers at commit, so a server slower than 5 seconds used to read as a stuck browser and restart it.
A `wait` gives up its turn too and takes no place in the gateway's queue, and looks every 5 seconds
rather than every second while other tasks are live, since each look brings its window back.

**One task's failure stays its own.** A navigation in doubt with another task at work closes that tab
instead of the shared connection. A task stopped in the middle of a native command or a screenshot
used to retire the whole browser; now the helper's answer is waited out and thrown away, except for a
press that would stay down, and input given up on lands before the next holder may act. Frames, file choosers and readiness checks are scoped to the tab, so a page
loading ads in one window doesn't refuse another's click.

**Daemon.** A brain's retirement used to hand the whole browser to the user. Now it asks `alone`: with
other tasks at work it only lets go of its own grant. A real takeover still takes everything. A task
whose grant the user's control ended, or whose browser was started anew, takes it again at the start
of its next turn, and waits out a restart in place. If its window went, it hears so.

**Exclusive relaunches.** Sign-in mode runs under the user's lease, and `switch_screen restart` under
the restarting task's turn, so others wait at the lane, shown as waiting for the computer. Restored
windows can't be matched to tasks, so sign-in mode first closes every window but the user's. A task
whose tabs are gone when it next comes forward hears why and reopens its page (`BROWSER_WINDOW_LOST`).

**Downloads.** One collector, which Chromium's single download directory requires. A download goes to
the task whose window started it, found through `frameId`; one that names nobody at work is refused.

**Replay.** One display gives one stream. Before a task's window comes up, every other task's
recording of that screen stops taking frames (`other-task` gap), and its own resumes on a key frame
300 ms after the raise, once frames already on their way have cleared. The user's control rests every
other task's recording on both screens. Desktop turns get the same gate.

## What remains

- Copied text doesn't survive another task's turn: a copy and paste split across turns pastes nothing.
- At most one download at a time across tasks (one spool slot). A task at rest beside others doesn't
  collect downloads; they are refused.
- A takeover aborts another task's browser action in flight rather than waiting for it.
- After sign-in mode or a browser restart, other tasks' pages are closed and must be reopened.
- One task's unconfirmed native input still retires the whole browser, as it always has, which costs
  every task its pages.
- A browser upload holds its turn while the bytes transfer.
- The browser's one gate can't name a tab. A refused saved key goes to the task whose last opened page
  matches the host, else to the last to act. Connections beyond the web from the browser have no card
  and are refused. An "Allow once" is per computer, not per task.
- A covered window keeps animating while its task is at work; pages nobody uses are frozen (see
  [the browser environment](../../browser-environment.md#pages-nobody-uses)). Finished tasks'
  windows count until closed.

## Phase 3: one screen

The owner asked for no separate browser view: "should just open browser in the main screen". The
browser stays in its own protected container, because merging it with the desktop would let the
sudo-capable desktop read the profile (with `--password-store=basic` the cookie key is hardcoded), let
any X client read or inject into another (keystrokes and masked fields), and lose `CapDrop: ALL`, the
read-only root and seccomp. Composing inside X fails the same way. So the stage composites: one screen
to the user, two video sources underneath. Everything is client-only except which screen an input is
for; dot's screenshots and coordinates stay each screen's own.

**Where it sits.** `stage/composite.ts`. The browser's whole 1280×800 picture fits under the desktop's
24 px menu bar and a 28 px title bar at one scale (0.935), so its pixels keep their shape, and a 42 px
margin of desktop shows each side. The other way to fill the width is to squash it or to crop what dot
can see, and a Chromium window one screen-bar shorter would change what dot's screenshots contain. The
stage reads one to one no more often than it did: its canvas almost never has a device pixel per frame
pixel.

**How it looks.** The owner asked for no foreign button: the browser should read as a native window on
dot's desktop. `stage/BrowserWindow.tsx` draws what the desktop's own apps have, from the desktop
image's own look (cells/desktop): WhiteSur-Light's xfwm4 title bar over the picture (white, a grey
edge, the title in Inter Semi-Bold 10 pt, #707070, centred), with the browser's name, as the page title
never reaches the app, and the minimise light alone, where the desktop's windows have their first: no
close, which would close dot's window, and no zoom. The web browser has an item in Plank's
localdot-glass (48 px icons 54 px apart on a 67 px shelf, 18 px corners, the same fill and strokes),
its own one-item shelf on the dock's line, 8 px right of where the desktop's nine pinned apps end. It
can't be an item of Plank's own dock, and can't move Plank's items aside: Plank is in the desktop's X
server, and the image stays as it is. Nor can the stage know where Plank is at a given moment: it
hides whenever a desktop window overlaps it (`window-dodge`), it grows by an item for each unpinned app
that runs, centred, and the browser's window covers it. So the item reads as the end of the dock when
the dock shows and as a dock of one when it doesn't; with two or more unpinned apps running it would
overlap Plank's last. A light under the item, in dot's colour, says dot works in the browser.

**Out of a window's way.** The item dodges windows as Plank does here (`hide-mode` `window-dodge`,
`hide-delay` 300 ms, `unhide-delay` 0, no pressure reveal: cells/desktop's localdot-plank). Any
application window over the dock's area, Plank's pinned shelf and the item's together (387 to 974 px
across, from 732 px down, at 1x), hides it, and so does the browser's own window in front. It comes
back while the pointer is at the bottom edge and stays while the pointer is on it, going 300 ms after
it leaves; a tap on the edge brings it for 4 seconds. With nothing over the dock it stays up.
`GET /api/cells/:id/dock` answers `{ covered }` and nothing else: the daemon reads desktopd's window
stack (`POST /windows`, frames only), at most every 0.7 s for every viewer, and the stage asks once a
second while it shows the desktop and the item. desktopd's reply names no window's kind, and the
desktop image stays as it is, so the desktop's furniture is told by its place: the desktop is the
whole screen at the bottom of the stack, Plank's window a strip the screen's width along its foot
(its frame stays the same whether Plank is up or not), the menu bar one along its head. A minimised
window keeps its frame in the stack with nothing to say it is hidden, so it still counts: the item
then waits at the edge although Plank is back. Until the computer answers, or when it can't, the item
keeps out of the way. The chrome is clipped to the stage, so a finger's reach past the picture's foot
can't make the stage scroll when the item takes focus.

**What follows what.** `useStageFront`: dot's latest confirmed screen is in front, unless the user
brought the other forward with the dock item, the minimise light, Alt+Tab, or a press on the menu bar
or beside the window. dot moving ends that, and so does the user handing back; taking control keeps
what is on show. A task on show that stops working, or that the page takes to be at rest, leaves its
screen in front; a ticket says whether the browser still runs, and which, so a browser restarted since
is the one shown and none falls back to the desktop. A new conversation, or one taken up, starts from
the desktop, as a task does. The window fades in over 160 ms, not under reduced motion.
Per-task windows don't change this: the stream is the display, so the stage shows the task whose
window is up, as in phase 1, and a task on the desktop isn't pulled along by another's turn in the
browser.

**Input.** `stagePoint` routes by rectangle: the window to the browser, the bar to the desktop, the
margins to nothing, since a click there must never land on a neighbour's control, and the title bar
to neither, as the stage's own. A bar too thin to aim at (under 16 CSS px, as on a phone) takes
nothing. A press stays on its own screen and stops at its edge. Keys and the control strip go to what
is in front; Alt+Tab or Command+Tab, from the keyboard field or a page with nothing else focused, bring
the other forward and reach neither (a Mac keeps Command+Tab for itself). The keyboard field keeps the
keys when the screens change places. The press that brings the other screen forward does so as it lets
go, so its release can't go astray while the screens change places. Each stream message may name a
`screen`; none means dot's, so a task that stays on one screen sends what it always did.

**The daemon.** A hold may reach either screen, as `forUser` already assumed for recordings.
`ManualStream` opens the access an input names, letting go of held buttons first. With dot on the
desktop, the user's first input to the browser takes it (`ScreenController.reachBrowser`): a hold that
stays on the desktop takes nothing from a task at work in the browser and costs nobody a reload. It
changes no selection, publishes nothing to dot, and refuses anyone but the user. The next agent grant
ends the user's control, which is what clears selections and reloads pages holding secrets. Recording
is fenced on both screens for the whole hold, as before; nothing about gaps changed. Masks are drawn by
browserd into dot's screenshots and aren't the stage's; the rings on fields dot asks about draw under
the browser's camera, on the page and in `targetRingBox`.

**Replay** records and shows each source alone, as before. It takes the stage with no composition, and
leaves no browser's picture behind it.

**Cost.** One extra client while the browser is in front, none otherwise. The desktop under the window
is a picture, refreshed every 30 seconds for the clock in its bar (`useUnderDesktop`): between, its
video is stopped, and the computer is asked for nothing on its account. It is live while the user holds
the computer, as their pointer may reach it. The browser covered by the desktop lets its client go after
a second and its picture after a minute. What an opaque window covers isn't drawn (`quadMesh`), since
each pixel of the quad costs up to nine texture reads.

Measured by `e2e/one-screen-measure.spec.ts` on real containers, in headless Chrome on an arm64 Mac whose
load average ran from 20 to over 100 under other work, so read these as ranges. The page in the browser
is a moving box and the desktop is still, unless it says otherwise.

| Chrome's CPU, one core = 100 % | Before | Watching | In control | Both moving |
| --- | --- | --- | --- | --- |
| 1440×900 at 2× | 45 | 26–56 | 27–39 | 63–71 |
| 390×844 at 3× | 21 | 26–30 | 22–25 | 29–30 |

On one running computer with the builds in turn, the stage painted the same 21 frames a second before
and after. A second client adds about 50 to 100 MiB to Chrome's 1.3 GiB, read within a run, since a whole
run's level moved by more than that. A still desktop under the window adds nothing the desktop cell's CPU
can show (7–32 % against 10–36 %).

## What remains after phase 3

- A click beside the window does nothing, and so does a tap on the menu bar on a phone.
- A press on the menu bar shows a menu only once it lets go and the desktop comes forward.
- The clock in the menu bar can be up to half a minute old while the user only watches.
- **Sign in without agent control** is offered only when dot's own screen is the browser.
- The title bar names the browser, not the page: the page's title would have to come from browserd.
- The dock item can't follow Plank: hidden, widened by unpinned apps or covered, Plank goes on as before.
- A minimised window over the dock's area keeps the item at the edge: desktopd would have to say which
  windows are hidden, a change to the desktop image.
