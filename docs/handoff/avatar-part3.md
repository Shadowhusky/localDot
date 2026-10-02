# Avatar Part 3 (V4 Voice): resume notes

These notes are written for an agent that picks this work up from GitHub. Delete this folder before
the branch merges.

## Branches

- `feat/avatar-part3`: the last finished commit is `c812a79`. It was built from `feat/avatar-part2`
  (`85bd897`), which the user approved.
- `wip/avatar-part3`: `feat/avatar-part3` plus two work-in-progress commits and these notes. Resume
  here, then rebase or squash the `wip` commits into proper ones before review.

## Done

- **Task 1:** `apps/voiced` service: token guard, lazy model slots, health (`8abfe37`).
- **Task 2:** streaming TTS with cancel, plus a review fix round (`48ef730`, `b76b024`, `a3e922d`,
  `198fc99`). The fix round added:
  - one sentence per model at a time;
  - per-sentence errors;
  - nothing sent after a cancel;
  - the voice preloads when a session opens;
  - a `max_tokens` cap.
- **Task 3:** aligner mouth shapes, per-language warm-up, `/visemes`, and stock-voice lip-sync
  fixtures scored at a 100 ms onset window (`8dbd3bf`, `7e5dfa6`).
- **Task 4:** `packages/voice` speech output, plus a review fix round (`7aab333`, `4379937`,
  `bb6affb`, `cfd9212`). The start lead is 0.16 s, and barge-in fades out over 15 ms.
- **Task 5:** host supervisor, router, `/voice/tts` gateway and Vite dev plugin (`a472a55`).
- **Task 6:** the harness say box, which speaks typed text with lip-sync (`fc2a655`).
- **Task 7:** speech input over push-to-talk and hands-free (`d1da5e4`). It has been reviewed, and
  its fix round is in progress (see below).
- **Task 8:** Azure fallback and ElevenLabs opt-in behind monthly budgets (`6476275`).
- **Task 9, partly:** a reply's language now follows its dominant script, and Chinese-only characters
  read as zh (`9e5bcab`).

## In progress

### Task 7 review fix round (`apps/voiced` only)

The original brief is `avatar-part3-task-7-brief.md`. The review asked for seven changes:

1. **Done** (`a138209`). **Early final.** At about 250 ms of pause, decode the turn and send it as a `partial`. At 500 ms,
   if no speech resumed, send that same text as the `final` with no second decode. Speech resuming
   between 250 and 500 ms continues the turn. Each turn's final is still decoded once. Re-measure
   13–16 s turns against the 750 ms hands-free budget.
2. **Reconnect after an unexpected failure.** After sending `recognition_failed` for an unexpected
   failure, close `/stt` with code 1011. The host relay then closes the page socket, and the page
   reconnects and re-sends `listen`. A failed decode keeps listening, as before.
3. **Done** (`614e4af`): the "each turn decoded once" test now pins exact text.
4. **Done** (`c812a79`): the partial schedule resets when `speech_started` is sent.
5. **Scaling.** The fake recognizer and detector reject input that is not float32 or falls outside
   ±1, so the int16 → float scaling is tested.
6. **Done** (`c812a79`): `speech_started` needs 3 consecutive speech frames (about 96 ms), so a
   cough does not interrupt her.
7. **Logging.** Call `log.exception` for non-cancellation errors in the reader task.

State in `wip/avatar-part3` (2026-10-02, 16:45 UK time): items 1, 3, 4 and 6 are done, and `pnpm test:voiced` is green (104 passed). Items 2, 5 and 7 remain; do them test-first. No agent is working on this lane now: the Claude agents stopped and their leftover servers were shut down, so ports 4752 and 4753 are free.

### Task 9: optional voice input in the browser

The brief is `avatar-part3-task-9-brief.md`.

State in `wip/avatar-part3`: `mic.ts`, `listener.ts` and `host/stt-relay.ts` exist with their tests,
and the harness and host files are partly changed. The TS suite passes (23 files, 131 tests), but
the task isn't finished. Rulings that amend the brief:

- **Notices:** `ready` clears every notice, and an audio frame clears `voice_offline`.
- **Language hint:** the harness passes the typed text's dominant-script hint (already in `lang.ts`).
- **Deny-permission live run:** add `--chrome-flag=--use-fake-device-for-media-stream`.
- **`fake-voiced.ts`:** it checks the token at the handshake, so add `request` back as the
  connection handler's second parameter for `/stt`.
- **Barge-in timing:** measured `bargeInMs` adds `FADE_OUT_S * 1000` (15 ms).
- **Changes from the Task 7 fix round** that the page must expect:
  - after an unexpected failure, `/stt` closes with 1011, so re-listen on reconnect and clear the
    error note;
  - `speech_started` needs about 96 ms of speech;
  - a pausing turn sends a `partial` and then the same text as its `final`;
  - a push-to-talk release after the 120 s limit may get no `end`.
- **Defaults:** voice input stays OFF by default. Ask for echo cancellation, with a half-duplex gate
  as the fallback.

Live runs need the Mac (see below). Code and unit tests can be done anywhere.

## Mac only: Task 10 and every live run

The voice service runs MLX models, which need Apple Silicon. The character's private voice pack lives
only on the developer's Mac and must never be uploaded. So these steps must run on that Mac:

- Task 10: latency acceptance against the budgets, recording the demo clip with the private voice, and
  measuring the mouth-vs-audio offset. If the mouth lags the audio by more than 45 ms on average, add
  a fixed viseme lead of about 42 ms in `buildTrack`.
- Every live browser or model check.

A cloud container can't do them.

## After that

One final whole-branch review on Opus. Never use Fable.

## Rules

- **Commits:** conventional style, `type(scope): summary`. **No attribution lines**: no Co-Authored-By
  and no "Generated with". Stage exact paths.
- **Hygiene:** `pnpm hygiene` must pass before every commit: no character or franchise names, no
  key-shaped strings. Never commit voice audio, clips or cloned output.
- **Gates:** `pnpm lint`, `pnpm typecheck`, `pnpm hygiene`, the touched tests, and
  `pnpm test:voiced` for Python changes.
- **Cost:** voice output defaults to local and $0. Cloud voices are opt-in only, and tests never call
  a paid API.
- **Ports:** voiced on 4752, the harness on 4753, capture Chrome on 9334. Never 9222 or 4790–4799.
- **Full context** lives on the developer's Mac and isn't in this repo: the plan, the spec, and the
  execution ledger with every ruling.
