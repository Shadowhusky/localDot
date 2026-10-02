## Rulings I made (main controller, Tasks 1–9 and the final review)
1. Task 8 regenerates its git-ignored probe image when missing — cost: none.
2. Task 1's typecheck "no projects" exit counted as a pass (zero packages existed) — cost: one skipped typecheck of zero files.
3. Spikes judged on evidence, reproducibility and constraints, not unit tests — cost: a buggy probe could mislead (raw output required).
4. Only scripts/check-hygiene.mjs may contain the private theme words (inside its regex) — cost: one file holds them.
5. Implementers and reviewers on Opus (your best-model rule), final review on Fable — cost: more tokens.
6. I created the repo, branch and empty base commit before Task 1 — cost: none.
7. (superseded by 8) Model spike limited to LM Studio.
8. The model spike used the keys from your notes with each provider's cheapest computer-use model; the OpenAI/Anthropic key file was deleted afterwards and Gemini read at point of use — cost: findings describe cheap models.
9. Biome 2.5 config fixes — cost: none.
10. Hygiene script skips deleted files and resolves paths from the repo root — cost: a few lines.
11. Network spike fix round: by-IP probes, positive controls, gateway probe, isolated-gateway retest — cost: one re-run.
12–13. A second session ran Tasks 10–14 in its own worktree; only this session merged — cost: one merge (lockfile conflict, resolved).
14. Stream fps target = fps while the screen changes (Selkies sends frames on change) — cost: partial-redraw apps may look less smooth; re-check in Part 2.
15. Accepted the frame-tap fix and a temporary 127.0.0.1 viewer port — cost: none.
16. Perception spike also checked 2× accuracy — cost: one run.
17. The other session ran the UI direction gate (you picked C: Theatre) — cost: none now.
18. Accepted the perception spike's helper files and brief fixes — cost: none.
19. Perception fix round re-measured 2× with GTK scaling on; input-path comparison moved to the timing spike — cost: a bigger timing spike.
20. Timing spike reused the perception image and the frame tap — cost: none.
21–23. (superseded by 24–26) Earlier ring-timing and input-path rulings.
24. Click ring = "input delivered": onset = raw press time + that injector's p99 latency; success criterion 3 reworded (needs your sign-off) — cost: rare rings up to ~11 ms early on press-acting controls.
25. desktopd types and clicks through its own XTest; Cua Driver only reads the screen — cost: background-window typing and click-hold need a Part 2 check.
26. Corrected timing numbers; Part 2 re-measures with ≥500 trials — cost: ring timing may need retuning.
27. Key-proxy spike tested Chromium's CA trust directly with headless Chromium — cost: none.
28. Key-proxy fix round: relabelled results, IPv6 probe; keyd must block the Mac's own addresses dynamically — cost: one probe run.
29. Accepted the Codex spike's mock probes and brief fixes — cost: none.
30. Codex fix round (no quota spent): decline every approval except our own MCP server's; Codex gets its own home — cost: none.
31. Accepted four derived amendments (dwell time, still screen ≠ stall, licence line, `doctor` network check) — cost: small spec edits.
32. Task 9 fix round limited to the gate-bind error; I fold the doc nits into the spec — cost: none.
33. Codex sandbox may not read /Volumes (your projects' .env files) or anything in ~ but its own home — cost: Codex may need extra read paths.
34. One final fix wave, including the daemon lock now rather than in Part 2 — cost: a slightly larger final diff.

## Rulings by the foundation session (Tasks 10–14)
F5. Opus implementers/reviewers, Fable final review — more tokens.
F13. Generated JSON Schema excluded from lint — none.
F14. Coordinate maths rejects degenerate sizes/scales — a few lines.
F15. One 0–1000 grid type also serves Gemini's 0–999 grid — ≤1.3 px.
F16. Cursor bow eased so there's no sideways jump — none.
F17. Dwell before a press scales with speed (fast = 45 ms) — 45 ms per action.
F18. Ports moved to 4750 / 4751 / 4760–4789 (4700 and 4734 are taken on your Mac) — a config constant.
F19. Empty or short tokens never match — none.
F20. Host check uses both the raw Host header and the URL host — none.
F21. Reused token file forced to 0600 — none.
F22. No cookie auth: Bearer for HTTP, WebSocket subprotocols, #token= bootstrap — a little more UI code.
F23. WebSocket upgrade handler never throws — none.
F24. Event-log appends are failure-atomic; only an unterminated tail is ever dropped — none.
F25. Sequence numbers advance only after a successful write; index failures repaired at startup — none.
F26. Startup reconciles the index with each session's file — none.
F27. Index files are 0600 — none.
35. Accepted the fix wave's choices (pid lock limits, empty LOCALDOT_PORT exits with an error, untested S7 profile) — cost: a confusing start-up refusal after a reboot.
36. Parked the re-review's small lock edge cases for Part 2's first daemon task — cost: a rare refusal or double start until then.
