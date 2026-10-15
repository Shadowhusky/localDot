# Purpose check and local autonomy

Verified 14 October 2026.

## What is running

Purpose check selects the saved HTTP key for api.typesafe.ai (the lexicographically
first matching key ID), otherwise the configured fast model where supported.
Jev requests use POST /v1/systemone and jev-latest. A live synthetic connection
test returned jev-1.13.0. The Settings section now shows the selected key, host,
model alias, actual returned version, connection-test result and request counters
since daemon restart. Key values never reach that section.

A configured key alone is not proof of a working connection. Opening Settings
reads local diagnostics; only Test Jev sends a synthetic provider request.
Counters include task judgments and explicit tests, with the latest kind shown.
They are process-local, not a historical billing ledger.

Full access bypasses both Purpose check and automatic approval judgments.
Off disables both uses of Jev. Even when active, untainted tasks, local operations,
destinations already allowed by the user and cached decisions need no API call.
Settings makes this distinction visible rather than asserting every step was
checked by Jev.

## Confirmation behavior

Full access delegates local operations, including file deletion and cleanup in
the isolated computer. The running task's own browser downloads reach ~/Downloads
without a Review, through the same release checks as the user's. Recognized
remote deletion asks, and "On this site" covers the rest of that site; purchases
ask every time. Credential handoff, keyd policy, container admission, network
restrictions and control ownership continue to apply. This is a permissive mode,
not a guarantee that command classification recognizes every possible remote
effect.

Auto sends a deletion inside the computer to Jev with a local-change question
and asks only when Jev is unsure. A named entry in a temp directory is cleared
without a judge, and files the task created go to its recovery folder. A
sweeping or irreversible deletion always asks: a home or system folder, the whole
working folder, a path filled in by a variable, find -delete from one of those,
disk tools, git reset --hard and git clean. A remote deletion, or a local one in
a step that also does something unclear, asks without a judge. Chromium's
background push connection is refused without a card. Custom follows the user's
policy. Selecting Full does not change those modes.

The reported promo task accumulated repeated local cleanup and spurious
destination confirmations. The destination scanner was reinterpreting Python/JS
heredoc bodies as shell commands, treating expressions such as glob.glob,
Image.new and JSON.stringify as hosts. Destination extraction now preserves
interpreter input. Real URLs, shell substitutions, nested shell programs and
network-capable interpreter code remain visible to the check. The conservative
action-risk parser retains its existing behavior.

At the time of the offline replay, all 15 recorded confirmations were shell
operations permitted by the corrected Full policy, and no code-expression hosts
remained. No recorded commands were executed. The 44-file safety/runner/routes/
settings/container suite passed 1,204 tests.

## Evidence and limits

The seven live synthetic Jev checks covered public documentation, private-data
sharing, an unrelated service, reversed answer order and an injected action label.
They passed their expected decisions. These are integration checks, not a
comprehensive adversarial benchmark or evidence of state-of-the-art performance.

[TypeSafe's API contract](https://docs.typesafe.ai/api) defines choice probabilities.
Malformed or non-normalized distributions are rejected. The
[model guide](https://docs.typesafe.ai/models) documents the stable alias;
[model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include
adversarial input and sensitivity to question structure. A classifier is an
advisory decision layer, not the isolation boundary.

[Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
combines filesystem and network boundaries to reduce approval interruptions.
Its remote Git proxy also scopes repository operations: keeping a token out of a
sandbox alone is not enough.
[Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
describes layered checks and user-intent evidence, with recovery from denied
actions rather than treating every denial as task completion.

localDot's desktop specification uses its own named home volume, no host-folder
bind or Docker socket, an isolated network and resource limits. keyd mediates
outbound access and credential injection. This limits direct host exposure but
does not make permitted remote operations reversible. Browser sessions and
connected APIs can still modify remote repositories, accounts or purchased
services. Container isolation also does not justify a claim of zero escape risk.

## Proposed restore points

Recommended, but not implemented by this change. Existing ComputerSystemState
captures a stopped desktop system image for replacement/update recovery, with
home-copy support. Runtime updates preserve the existing home and browser profile.
Those mechanisms are not independent, user-selectable historical restore points.

[Docker commit excludes mounted volumes](https://docs.docker.com/reference/cli/docker/container/commit/).
A complete restore point needs:

1. An exclusive lifecycle hold: no running agent, manual control, executors or
   credential grants; stop both desktop and browser writers.
2. The desktop system image plus independent copies of /config and the isolated
   browser's /profile volume. Keep metadata outside the agent's writable computer.
3. A durable manifest binding exact image and volume identities, version,
   timestamps and verified completion. Publish only after every component succeeds.
4. Restore into new volumes/containers; verify boot and browser readiness before
   switching the active computer. Preserve the current computer until success.
5. Explicit retention limits, available-space checks and deletion of only resources
   owned by that restore point. Never prune the sole recoverable copy on failure.

The UI should expose Create restore point, dated entries and Restore. Explain that
restore rewinds local apps/files/browser state and ends current sessions; it does
not rewind cloud services, sent messages, payments or remote Git operations.
Do not restore daemon/keyd authority or stale proxy credentials from the snapshot.
A restore failure must leave the original computer recoverable. These guarantees
need crash, concurrent-write, low-disk and failed-start tests before shipping.
