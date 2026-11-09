# A web browser per conversation

Status: design for `feat/session-browsers`, from the profile-slots trial (Nov 6). It replaces "one
browser, a window per task" from [2026-11-04](2026-11-04-parallel-browser-windows.md) whenever
there is room for another browser, and falls back to it when there isn't.

## Problem

"When several sessions are using browser it always race with each other." One browser has one
display: tasks take turns on it, a turn raises a task's window, the stage shows whichever task acted
last, a menu closes when another task's turn takes focus, copied text doesn't survive another task's
turn, and the user taking the browser takes it from every task.

## Decision

**A conversation that uses the web browser while another conversation has the computer's browser
gets a browser of its own: a second browser cell, with its own profile slot.**

- **Separate containers, not separate Chromes in one container.** browserd, its supervisor, its
  stream and its gate are all built for one Chromium on one display; a cell per browser reuses them
  unchanged. Docker mounts give the isolation: a browser cell mounts only its own slot, so nothing in
  it can read another slot's cookies, and one browser's crash, out-of-memory kill or restart is its
  own. A second Chrome in the same container would share its uid, its memory limit and its `/profile`
  mount, and need a second display, stream and supervisor in browserd. The cost is a gate container
  and two networks per browser (measured below).
- **Slots, one writer each.** A slot is a Chrome user-data volume. The computer's *main* slot is the
  accounts volume the browser has always used; it holds the sign-ins every conversation starts from.
  A *conversation slot* is a volume of its own (`<prefix>profile-<browser cell id>`, the name a browser
  cell's own profile always had), made once, from the main slot, the first time its conversation needs
  it. Only that conversation's browser ever mounts it.
- **Who gets which.** The first conversation to need the browser while nobody else is using the main
  one gets the main browser, exactly as before; sign-ins made there are everyone's. A conversation
  whose tasks are using the main browser keeps it until none of its tasks is live. Another
  conversation that needs the browser meanwhile gets its own, and keeps it for its follow-ups. A
  shared link's task never gets the main browser: always one of its own, copied from the main slot
  only when the link allows the owner's browser (rc.44); without that it has no web browser at all.
- **How a slot is copied.** In a helper container with no network, no capabilities, a read-only root
  and the main slot mounted read-only. Caches, `Singleton*` locks and session tabs are left out. The
  browser-wide components are copied while the main browser runs; then the main browser's container
  is paused (the cgroup freezer: no process can write) for the copy of `Local State` and `Default/`,
  about 23 MB, and resumed at once. So the copy is a point-in-time snapshot, the live profile's lock
  and cookies are never touched, and Chrome never finds a database half-written. Every SQLite file of
  the copy is then opened and checked (`PRAGMA quick_check`).
- **Google stays in one browser.** Google ends a session used by two browsers at once, and signs
  every holder out, the main browser included (the trial: 23 and 38 minutes). So the copy leaves out
  the cookies of sites that do this: Google's (google.*, youtube.com, gmail.com and the account hosts)
  and Microsoft's account hosts. A conversation's browser signs in to those itself if the user asks.
- **Sign-ins flow back only when the user says so.** Nothing a conversation's browser does reaches
  the main slot by itself, and a slot is never copied over another. **Keep sign-ins** (Settings →
  Accounts, beside a conversation's browser) copies that browser's cookies for the sites whose
  cookies changed since its slot was made, through the two running Chromes (CDP's `Storage`), into the
  main browser. A site whose cookies the main browser also changed since then is left out and named,
  and so is a site Google-like sessions would end. Sign-outs never flow. A shared link's browser can't
  be kept.

## Limits

- **Live browsers per computer:** the main one plus `extra`, where `extra` follows Docker's memory:
  `floor((MemTotal − 4 GiB) / 1.25 GiB)`, at most 3, and `LOCALDOT_SESSION_BROWSERS` (0 to 3) sets it
  by hand; 0 is the old behaviour. 1.25 GiB is the trial's loaded browser; a 7.65 GiB Docker gets 2
  extra, a 4 GiB one none.
- **At the limit,** a conversation browser none of whose tasks is live, the one used longest ago, is
  parked: its cell stops, its slot stays. It starts again, on the same slot, when its conversation
  needs it (pages closed, sign-ins kept; dot is told). With nothing to park the task shares the main
  browser in a window of its own, as before, and dot is told why.
- **Idle:** a conversation browser none of whose tasks has been live for 10 minutes is parked.
- **Disk:** at most 6 conversation slots per computer; past that the one used longest ago is
  removed. A slot unused for 24 hours is removed. A parked slot loses its caches. Removing or
  replacing a computer, and **Sign out of all sites**, remove its slots; **Go back to Chromium**
  removes all of them (a slot copied from a Chrome profile can't go back).

## Failure handling

- One browser cell per conversation: browserd's own in-place restarts and the daemon's replacement
  of a silent browser act on that cell alone. A task whose browser restarted hears so (as before).
- Turns: each browser has its own lane on the computer's lease (`browser:<key>`), so tasks in
  different browsers act at once; tasks sharing the main browser still take turns. The user's
  control takes the desktop's lane and the lane of the browser of the task they hold, nothing else.
- Daemon restart: every browser cell is stopped at startup (as before); slots and their
  conversation bindings are kept on disk and start again on demand.
- A copy that fails, or a database that fails its check, leaves no slot behind: the volume is
  deleted and the task shares the main browser, told why. A pause that can't be undone is retried
  and then the main browser is restarted.
- Leaks: every slot volume and browser cell carries its owner labels; startup removes slots whose
  conversation binding is gone, and cells it doesn't own are never touched.

## What stays

The window, minimise light, dock item and Alt/Option-Tab of rc.42; the busy-page waits and redirect
following of browserd; anti-detection as documented in
[browser-environment.md](../../browser-environment.md): no concealment; each browser runs the same
image, flags and gate.
