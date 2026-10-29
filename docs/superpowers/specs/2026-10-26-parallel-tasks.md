# Several tasks at once — design and decision

Status: design note, deferred by the owner on 2026-10-26. Nothing here is built. A partial start of
Phase 1 is saved as `~/builds/localdot-qa2/notes/parallel-tasks-phase1-partial.patch` (diff against
the 2026-10-26 live snapshot; it also contains the already-shipped Claude Code tool-check and
end-of-task fix). It doesn't compile cleanly yet: the stop-all test fakes and some runner tests
still need updating.

## Request

"Should support multiple agent tasks at once, for example when create a new conversation while a
previous one is running, they should both run in parallel (but consider conflicting and race
conditions). Make sure the mechanism is robust and UI/UX is great."

## Decision

The owner chose **share the computer, take turns**:

- Several tasks run at once.
- Thinking, web search and fetch, memory, plan, questions to the user and connected-app tools run in
  parallel.
- Work on the computer (desktop, managed browser, shell, files, uploads and downloads) takes turns
  through an exclusive per-computer lease.
- It is built queue-first.

Rejected:

- **Truly simultaneous input on one computer.** See "Why the computer is exclusive".
- **One computer per task.** Each extra task needs about 8 GiB, starts cold, can't share the
  signed-in browser profile, and its files don't follow the conversation. It may come back later as
  an opt-in "spare computer" when capacity allows (`dots/capacity.ts`).

## Why the computer is exclusive

The managed browser is one physical surface, not independent CDP targets:

- browserd has a single control holder. Switching holders reloads pages that hold secrets and
  clears selections (`cells/browser/browserd/src/control.ts` ~53-54, 108-124).
- Input is XTest (`browserd/src/input.ts` ~75).
- Capture is an X grab of the visible window (`browserd/x/browser-capture.py`).
- Only one browser may hold the signed-in profile (`daemon/src/cells/browser-orchestrator.ts`
  ~120-128).

The desktop Chromium profile is rotated at every task start (`agent/wiring.ts` ~224-254).
Recordings tap the computer's stream (`recorder/recorder.ts` ~139-180).

Interleaving steps from two tasks would leave models acting on stale screenshots and approvals
pointing at a screen another task changed. It would also make Stop, network asks, recordings and
cleanup blame the wrong task.

## Where the code assumes one task per computer

Re-verify these; they were taken from a snapshot.

- **Live registry:** `gateway/live.ts` ~41-55, 113-120 (`#byCell`). The user's hold also takes the
  slot (`agent/runner.ts` ~859-940).
- **Admission:** `runner.ts` ~429-456 (`#starting`, which retires an idle owner) and `release()`
  ~768-809. `agent/routes.ts` ~646-686: New and Continue call `release`.
- **Global conversation pointer:** `agent/conversation.ts` ~107-127, read at `runner.ts` ~555 and
  adopted ~700. It races with switching conversations.
- **Computer-wide Stop:** `gateway/kill-switch.ts` ~42-107. Screen containment stops the computer
  too (`browser/session-screens.ts` ~115-127).
- **Attributed per computer, not per task:**
  - keyd events: `keyd/event-router.ts` ~113
  - network asks: `wiring.ts` ~1024-1029, `safety/connections.ts` ~371-402
  - uploads: `wiring.ts` ~780
  - downloads: `wiring.ts` ~1075-1080
  - fences: `safety/fences.ts` ~113-130
  - the native-task record: `safety/native-tasks.ts` ~36
- **Routines** poll for up to 30 minutes (`routines/launch.ts` ~199-237). The update idle check is
  in `main.ts` ~603 and `cells/computer-update.ts` ~545.
- **Web app:**
  - `/api/cells/:id/live` (`gateway/routes.ts` ~137-142)
  - `session/useLiveSession.ts` ~189 and `App.tsx` ~602-608
  - `agent/conversation-list.ts` ~28-42 and `session/status.ts` ~485-489
  - `agent/conversation-state.ts` ~4-31: New is blocked while a task runs
- **Already per task:** the brain container (`runner.ts` ~1692), shell process groups, safety
  intents.

## Plan

### Phase 1: per-computer queue (estimate 11–14 focused days)

- **Status and events:** add a `queued` session status and a `task.queued {position, behind}` event.
- **Queue:** a FIFO per computer in the live registry. A per-computer admission mutex replaces
  `#starting`. The next task is admitted atomically when the owner settles. User tasks go ahead of
  routine runs.
- **When the queue holds:** it doesn't advance while the computer is paused, fenced,
  updating/replacing or held by the user.
- **Explicit conversation:** a start names its conversation (`continues: <latest task>`) instead of
  the global pointer. It returns 409 if that conversation already has a live or queued task; send a
  follow-up instead.
- **New and Continue** only navigate. An idle owner is released only when another task is waiting.
- **Live endpoint:** `/api/cells/:id/live` returns `{owner, queue}` and keeps `sessionId` for the
  CLI's stop.
- **Stopping:**
  - Stop on a queued task cancels it.
  - Stop everything clears the queue.
  - After a restart, a queued task shows "Didn't start — Send again" with its text restored.
- **Routines** join the queue. The update idle check counts queued tasks as busy.

### Phase 2: parallel model work with a lazy computer lease (estimate 10–13 days)

- **Live vs. owner:** "task is live" is separate from "task holds the computer". Every brain starts
  at once.
- **Waiting for the lease:** tools that don't touch the computer run freely. The first computer,
  browser, shell, files, upload or download call waits for the lease. The wait is abortable and
  shown as "Waiting for the computer".
- **On acquiring the lease:** prepare the desktop as task start does today, start that task's
  recording, and give the model a fresh full screenshot.
- **How long it's held:** until the task's turn ends. Never mid-turn, and never while it waits on an
  approval, question or takeover that refers to the current screen.
- **Attribution:** keyd events, network asks, uploads and downloads go to the lease holder.
- **Stopping a non-holder** ends only that task (revoke its brain's keyd grant) and never freezes the
  computer.

### Races to handle

| Race | Handling |
| --- | --- |
| Two starts at once | Admission mutex; queueing is atomic. |
| Owner settles while a queued task is cancelled | Next task taken in one synchronous step, then readiness rechecked. |
| Follow-up reaches an idle owner as it is released | Requeue it. |
| Owner waiting for the user | Keeps the lease; others show "<A> needs you". |
| Takeover or the user's hold | Counts as holding the lease. |
| Leftover processes after hand-over | Same exposure as today's back-to-back tasks; name the owning app in network asks. |
| Brain crash while waiting for the lease | Leaves the queue cleanly. |
| Stop during lease hand-over | Must not freeze the computer for the wrong task. |
| Daemon restart mid-queue | Queued tasks come back as "Didn't start — Send again". |

### UI/UX

- **Composer:** New conversation is always available. While another task holds the computer, the
  composer says "dot is working on '<A>' — this will share the computer", and sending still starts
  the task.
- **Thread card:** "Waiting for the computer · after '<A>'" with **Start now** and **Cancel**.
- **Conversation list:** Running (marks the one on the computer), Waiting for computer, Queued,
  Needs you, Done. Active rows are pinned to the top.
- **Stage:** an "On screen: <A>" chip with a jump link.
- **Island:** the viewed task, plus a "<A> needs you" / "2 need you" pill using the existing
  attention hook.
- **Stop and Take control** name the task they affect.
- Works at phone widths and in light and dark mode.

### Tests

- Unit tests for the queue and lease, and for each race, using deferred promises.
- A seeded fuzz test across three conversations (start, stop, message, ask, takeover, restart). It
  checks:
  - at most one lease holder per computer;
  - no computer tool runs without the lease;
  - events land in the right log;
  - every queued task starts or ends.
- Extend the runner, wiring and session-screens boundary tests.
- Web tests for list statuses and for switching conversations while tasks run.
- Visual checks at desktop and phone widths.
