# S9 — passive Selkies recording

Measured on 2026-10-04 on Mac15,14 (28 physical cores, 96 GiB), macOS 26.6.2
(25G83). Docker client/server 29.2.0, Linux arm64 engine; Chrome 154.0.8037.95;
Node 24.19.0. The cached image is `localdot/desktop:ui14-20261004-b1`, with image ID
`sha256:8b9b4b9d6341c0d4b8a02fb50c4ecb2e0233b3cd4e9b2e8be8a8385522c86187`.
It was run with `--pull never`. All content was a local synthetic moving pattern or
the XFCE desktop. No account, provider, model call or external website was used.

## Decision and gate

**PASS:** a separate passive connection records the same H.264 stream without
changing the viewer's size or format. Key-frame requests work during motion and
on a still screen. The measured CPU delta is below the 10-point feed-mode gate.

| Constant | Measured choice |
| --- | --- |
| `RECORDER_HANDSHAKE` | `/api/websockets?role=viewer`, no subprotocol/compression; on `MODE websockets`, send `STOP_VIDEO`, wait 250 ms, send `START_VIDEO`. Ping every 500 ms. On `PIPELINE_RESETTING primary`, report the reset and restart the bounded video watchdog; do not immediately echo `START_VIDEO`. |
| `KEYFRAME_EVERY_MS` | `2000`; enforce a request gap of at least 500 ms. |
| `IDLE_KEYFRAME` | `true`: still-screen requests produced IDRs, p50 21.246 ms, maximum 32.661 ms. |
| `FEED_MODE` | `own-connection`: measured CPU increment 0.068 percentage points of a core. |

The recorder sends no `SETTINGS`, `CLIENT_FRAME_ACK`, `_gz,1`, input or clipboard
messages. The CLI's primary/controller mode exists only for comparison. A stream
reset retains the recorded size and codec in the exercised explicit transport restart. The
production watchdog still needs bounded retries and the Task 10 format-change
policy; the spike does not authorize silently accepting different geometry.

## Q1 — handshake, alone

The shared/viewer handshake above works alone at both scales. The initial key
payload contains SPS, PPS and IDR. Primary/controller with `SETTINGS,{}` is faster
at startup but is unnecessary and must not be the recorder's handshake.

| Scale | Shared frames / keys in 12 s | Shared first key | Primary frames / keys | Primary first key |
| --- | --- | --- | --- | --- |
| 2×, 2560×1600 | 12 / 2 | 289.016 ms | 7 / 3 | 43.942 ms |
| 1×, 1280×800 | 14 / 2 | 275.656 ms | 7 / 3 | 34.977 ms |

`endpoint.ts` consumes the existing Ready-cell `CellApi.endpoints(id).stream`
contract and writes a mode-0600 file with the existing per-cell credential. It
uses the orchestrator's authoritative endpoint rather than reconstructing the
current gate's published ports from a guessed cell layout.

## Q2 — viewer order, departures, reset and restarts

The actual assembled Theatre, daemon, proxy and pinned cell were exercised. A
private copy of the proxy recorded only video headers/arrival times and selected
control text; no payload or credential was logged. Production proxy and vendor
source were unchanged. All recorded frames stayed H.264, region 0, 2560×1600,
with SPS codec `avc1.f40033`.

- **(a) Viewer first:** ten recorder joins/leaves, each 76–77 frames and one key.
  Every one of the 765 probe frames matched a real viewer relay frame ID within
  100 ms. Viewer samples stayed 2560×1600 and 61–63 fps.
- **(b) Recorder first:** video arrived before the Theatre opened. The subsequent
  viewer handshake retained geometry and codec. Its first sample was startup
  (one decoded frame); sustained samples after startup were 57–62 fps.
- **(c) Viewer leaves:** the recorder continued through the three-second absence.
- **(d) Viewer returns:** five returns, each at 2560×1600, observed 57–58 fps after
  startup. The recorder remained connected throughout.
- **(e) Confirmed reset:** the production shared Theatre was left unchanged. An
  explicit primary/controller reference restarted its own stream using
  `STOP_VIDEO`, 250 ms, `START_VIDEO` and received `PIPELINE_RESETTING primary`
  251.512 ms after the command. The shared recorder received no peer reset notice
  before its own later restart; it delivered 308 frames during that interval.
  The whole run delivered 924 frames, five keys, the same `avc1.f40033` codec and
  2560×1600 geometry, with largest frame gap 35.411 ms. Theatre samples were 62,
  62 and 61 fps. The recorder's explicit later `START_VIDEO` produced its own
  reset notice and video continued. Reset notices must report state and rearm
  the bounded watchdog; immediately echoing a START for each notice could loop.
  This is an explicit primary-reference transport restart, rather than a claim
  that the locked shared Theatre can change global video settings. The earlier
  settings-only attempt is retained but is not credited as reset causation.
  The continuous b–d run separately delivered 1,825 frames, 18 keys and a largest
  motion-frame gap of 44.418 ms. There were 1,155 frame-ID matches within 100 ms
  while the viewer was present; absent-viewer periods have no relay witness.
- **(f) Resend `START_VIDEO` every three seconds:** over 60 seconds of motion,
  20 starts (including the handshake) produced 3,684 frames and ten keys. The
  largest frame gap was 38.296 ms; viewer remained 2560×1600 at 62 fps. On the
  mostly still pattern, 20 starts produced 114 frames and 19 keys; viewer size
  stayed unchanged (2 fps reflects still content). A resend does not invariably
  produce an IDR. Observed key payloads were 31,382–32,042 bytes under motion and
  36,037–63,013 bytes on the still pattern. A 30-second idle watchdog restart can
  therefore cost roughly one such access unit; periodic key requests are used
  separately to bound recording fragments.

## Q3 — wire header

All inspected video headers had byte 0 = 4, H.264 codec nibble 1 and region 0.
The low nibble's key flag matched the presence of NAL type 5. Dimensions were
2560×1600 at 2× and 1280×800 at 1×. The header is 12 bytes: flags at 1, big-endian
frame ID at 2, region at 4, width at 6, height at 8 and extra at 10. The frame ID
is 16-bit; arrival time, not its numeric ordering across wrap, must drive PTS.

## Q4 — SPS/PPS and actual codec

Every observed key payload carried in-band NAL types 7, 8 and 5. `ffprobe` decoded
captured access units at both scales. The full-colour 2× stream is
`avc1.f40033`, High 4:4:4 Predictive, 2560×1600, `yuvj444p`, level 51; the 1× stream
is 1280×800, level 40. Both have no B frames.

With `SELKIES_VIDEO_FULLCOLOR=false|locked`, the real image produced
**`avc1.42c033`**, Constrained Baseline, `yuv420p`, 2560×1600, level 51, with no B
frames. This differs from the planned High-profile (`avc1.64…`) expectation.
Derive the codec from SPS bytes; do not hardcode that expected profile. Chrome's
actual `VideoDecoder.isConfigSupported` returned true for both observed 2× codec
strings. Captured payloads stay outside the repository.

## Q5 — requests and cost

During 27 seconds of motion, 53 requests at 500 ms spacing all received a
subsequent key: p50 510.067 ms, maximum 1,012.186 ms. There were 1,648 frames and
27 keys, with largest inter-key interval 1,498.087 ms. At this aggressive request
rate several requests can share the same next IDR; the transcript records each
request separately. The maximum exceeds one second, so the feed must not assume
an immediate key frame.

On a still screen, all nine requests at two-second spacing received keys: p50
21.246 ms, maximum 32.661 ms, ten keys in 20 seconds. The largest key interval was
2,014.526 ms. The recorder does not need input or viewer acknowledgements to
obtain an idle key.

Two 60-second motion windows measured bytes as received by the real viewer
(12-byte video headers included), with the same ACK-enabled receive reference:

| Condition | Frames | Keys over enclosing 64 s | Viewer bytes/s | Probe bytes/s |
| --- | --- | --- | --- | --- |
| No requests | 3,700 | 1 | 910,253.283 | 910,253.283 |
| Request every 2 s | 3,697 | 32 | 884,189.333 | 884,189.333 |

All 31 two-second requests in the latter enclosing run were answered (p50
13.690 ms, maximum 22.991 ms). The observed rate was 2.86% lower with requests;
this is a single synthetic pair, not proof that requests always reduce bandwidth.
Viewer samples stayed 2560×1600 and 62 fps in both windows.

## Q6 — natural cadence

Without requests, a 63.057-second motion run produced 3,870 frames but only its
startup key. Therefore the open GOP extends for more than 62 seconds; there is
no complete natural inter-key interval to report, and a null interval must not
be interpreted as zero. A five-minute mostly still desktop produced 36 frames,
six keys, 2,577.697 bytes/s and a largest completed interval of 60,022.482 ms.
Natural cadence alone does not bound a ten-second fragment. The gate permits
continuing because Q5 proves effective periodic requests; the writer must use
them and retain its 10-second GOP bound and error policy.

## Q7 — cost and feed mode

Three motion runs sampled `docker stats` 24 times each over approximately one
minute, using the unchanged actual Theatre/vendor and no key-frame requests:

| Condition | Mean container CPU |
| --- | --- |
| Theatre alone | 175.405% |
| Theatre plus passive recorder | 175.473% |
| Passive recorder alone | 171.376% |

The addition was 0.068 percentage points, below the 10-point gate. Use an own
connection. These valid Q7 measurements are retained from a combined runner
whose later Q8 ACK assertion failed; that runner is not credited as an overall
PASS.

## Q8 — frame delivery and ACK reference

The production shared Theatre intentionally sends no `CLIENT_FRAME_ACK`. The
first combined run observed 3,452 viewer frames and 3,452 probe frames over its
56-second common window, all IDs matching, but zero ACKs. Its requested ACK
condition failed and remains a diagnostic.

The final check used the unchanged Theatre/vendor with explicit receive ACKs
sent through its existing iframe transport every 80 ms. A private read-only IPC
provided the latest viewer relay header and its receipt time. This is a **receive
ACK reference**, not a claim of the vendor's native presentation/decoder ACKs.
The recorder itself sent zero ACKs. Chrome continued decoding at 62 fps.

In the no-request 60-second window, 740 actual ACK messages traversed the viewer
relay; the probe and viewer each received all 3,700 frames, IDs 276–3975, with
100% matching IDs. In the two-second-request window there were 739 ACKs and
3,697 matching frames, IDs 4224–7920. Both exceed the required 98% gate.

## Evidence and cleanup

Raw transcripts, headers, command receipts, fixture ownership/cleanup records,
synthetic key dumps and instrumentation bindings are retained in the controller's
S9 evidence package. Successful final checks are `host-q1-role-v3`,
`host-q2-role-v3`, `host-q2-reset-v6`, `host-q2f-q5-v1`, `host-q6-idle-v1`, `host-q4-fullcolor-v1`,
`host-q4-metadata-v2` and `host-q8-cost-v3`. `q7q8-v1-results.json` contributes
only the Q7 measurements and the diagnostic Q8 comparison. Early wrong-role,
stale setup, blank-context codec and missing-module attempts are not acceptance.

Every successfully acquired S9 desktop has an exact owned-ID removal/absence
receipt. Daemon fixtures also record removal of their own desktop, gate,
networks and volume. Shared preview services and the user's shared daemon were
not changed. The pinned offline acceptance record was refreshed solely because
the new cached `ws` importer changes the lockfile's native input binding.
