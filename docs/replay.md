# Replay and MP4 export

localDot records a session's computer locally, including sessions with no viewer connected.
The recording stores the computer's video. Replay reconstructs pointer motion, delivery rings,
step labels, and other overlays from the event log when you watch or export it.

## Watching a recording

Choose **Replay** and select a session in the history rail. Drag the timeline to scrub; the step
chapters and activity marks show where work happened. Choose a step in the rail to jump to it.
**Skip idle** compresses inactive stretches, and playback speed ranges from ½× to 8×. A label
shows when the picture is sped up or idle time is skipped. Before/after comparison uses saved
screenshots for the selected step. A session still running offers **Jump to live**.

For sessions that used the web browser, use **Desktop** or **Browser** above the stage.
Both tracks share the session timeline. Changing tracks pauses playback and keeps the same time,
speed and idle-skip preference. Pointer overlays, hover screenshots and before/after comparisons
follow the selected screen. If that screen has no recording, Replay uses only screenshots from
that screen; it never substitutes the other recording. Older sessions default to Desktop.

| Key | Action |
| --- | --- |
| Space | Play or pause |
| K | Pause |
| Left / Right | Previous / next step |
| J / L | Back / forward ten seconds |
| `[` / `]` | Slower / faster, from ½× to 8× |
| B | Before/after comparison |
| Escape | Close comparison, or return from Replay |

These shortcuts yield to text fields and open export controls. On the focused timeline,
Left/Right scrub one second and Home/End seek to the range edges.

## Privacy and gaps

No video or observe screenshots are recorded while you have taken control. Replay and export
hold the preceding picture and show **You had control here** for that interval. A lost stream,
full disk, recording size cap, or recorder failure is shown as a gap rather than silently hidden.
Sessions without usable video can still show their saved steps and screenshots.

A late key frame at the takeover boundary or the first key frame after you hand control back
can contain what you left visible. Close private pages and clear sensitive screen contents
before handing control back, and review the exported range before sharing it.

The export sheet displays this privacy notice:

> This video shows everything on the computer's screen in the range you chose. Fields marked secret appear as dots. Stretches where you had control were never recorded.

Review the range before sharing a video: visible documents and page contents are part of the
picture. Export happens in your browser and writes to the file you choose. The export contains
rendered video, including overlays and any enabled captions; it does not attach the event log,
session ID, daemon token, home path, or identifying metadata tags. The suggested name contains
only the local date and time. No upload endpoint is used.

## Saving an MP4

Pause at the desired step and choose **Export MP4**. Select the whole session or current chapter;
when a selection is available, it can be exported too. Choose 1×, 2×, 4×, or 8× speed, idle
compression, captions, and an available output size: 1280×800, 1920×1200, or 2560×1600. The
browser checks encoding support before enabling a size. The output is H.264 video at 30 fps.

An export captures the selected Desktop or Browser track when you open the sheet. Its label names
that screen; browser exports add `-browser` to the suggested filename. The selected track's privacy
gaps and the committed recording snapshot remain fixed for that export.

**Save…** opens the browser's file picker. Keep the tab open while export runs. Progress shows
completed frames and an estimated time remaining; **Cancel** asks before stopping an active
export. Errors abort the pending write. Desktop Chrome needs `showSaveFilePicker`, WebCodecs
H.264 encoding, and OffscreenCanvas. Unsupported browsers receive an explanation in the sheet.

## Files, retention, and disabling recording

The default home is `~/.localdot`; `LOCALDOT_HOME` overrides it for the daemon. A session has:

```text
sessions/<id>/
  session.json
  events.jsonl
  frames/
  thumbs/
  summary.json
  recording-browser/  # Separate browser track, when present; same files as recording/.
  recording/
    manifest.json
    video.mp4
    fragments.jsonl
    journal/
```

The manifest records video state, dimensions, committed fragments, activity intervals, and gaps.
Fragment bytes are committed before their index entry. After an interrupted recording, recovery
serves committed fragments with a synthesized MP4 tail rather than exposing an unfinished tail.

Configure the daemon before starting it:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `LOCALDOT_RECORDING` | enabled | Set to `0` to stop new video recording; existing recordings remain usable. |
| `LOCALDOT_RECORDINGS_MAX_DAYS` | `30` | Maximum age of eligible finalized recordings. |
| `LOCALDOT_RECORDINGS_MAX_GB` | `20` | Completed-video budget in GiB (1024³ bytes per unit). |

Limits must be positive finite numbers; invalid values use the defaults. Retention runs at
startup and after recording completion. It removes the oldest eligible finalized videos and
their fragment/journal files, marks their manifest expired, and preserves session events,
screenshots, and thumbnails. Live or unfinished recordings are not retention candidates.
**Delete session** in history removes the selected session; it is separate from video retention.

## Acceptance commands

The current CI workflow has no browser job. To run the Docker-free Replay and export checks
locally, install Google Chrome and the pinned dependencies, then run:

```sh
pnpm --filter @localdot/web build
pnpm --filter @localdot/web e2e --project=hidpi replay-pins.spec.ts replay-ui.spec.ts export.spec.ts
```

These fixtures use synthetic recordings, private daemon/keyd homes, and a fake Docker socket.
They include a two-hour export and can take several minutes. Their screenshots and measurements
are in `apps/web/e2e/out/`. They require loopback networking, local process creation, the Go
toolchain for keyd, and browser permissions for headless Chrome.

With the local desktop/gate images built and Docker running, test a real recorded desktop:

```sh
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e --project=hidpi recorded-session.spec.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e
```

The recorded-session fixture records the multi-app puppet with no viewer, compares decoded
Replay frames with saved thumbnails, jumps from a running recording to Watch, and decodes the
first and last samples of an exported MP4. Fixtures own their test cells and remove them after
the run. Keep the test daemon port 4790 free. Some older whole-suite checks require external
test endpoints; the recorded-session check uses only the bundled demo page and local apps.

mediabunny is pinned to 1.61.0 under MPL-2.0. Its attribution is in `THIRD-PARTY.md`; the browser
build includes the full notice at `apps/web/dist/licenses/mediabunny-1.61.0.txt`.
