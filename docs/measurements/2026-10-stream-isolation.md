# Two-viewer isolation and suspended-tab recovery

Verified on the local Mac with the real desktop image and Chrome on 2026-10-02.

The stream proxy now opens Selkies sockets with the fixed `role=viewer`, and the hidden desktop
client uses shared viewing mode. Previously two theatre tabs both claimed the primary display;
opening the second could replace the first before any backpressure test began. The fixed server
role also prevents a theatre connection from acquiring control input.

The real test launches viewers in separate Chrome processes, establishes both streams, and checks
that both remain connected while one renderer is genuinely frozen. A full-size changing noise
image creates enough traffic to back up its socket. The live viewer delivered 14.6–16.4 fps across
six five-second windows, staying above half its measured steady rate, while the frozen connection
accumulated 3,536,082–4,093,959 bytes. On thaw it recovered above 10 fps within the test's 60-second
bound, and Stop completed. The run passed in 54.8 seconds.

Recovery remints a stream after browser suspension and detects a decoder advancing behind a
stalled frame tap. Canceling an old transferred stream no longer waits for an upstream cancellation
acknowledgment that a suspended renderer may never send. Worker frame counters remain cumulative
across reconnects, and animation scheduling can resume on a view update.

The desktop image also hashes its random stream password through OpenSSL stdin. A valid base64url
password beginning with `-` previously became an OpenSSL command-line option. The image test now
uses such a password, and all 19 real desktop-image tests passed. The bundled license count was
updated for the MCP SDK and its dependencies.

Other verification: 622 host tests across 83 files, workspace typecheck, lint, hygiene and the web
build passed. Local run records are `/tmp/localdot-two-viewers20.log`,
`/tmp/localdot-desktop-image-hyphen-suite.log`, and `/tmp/localdot-host-all5.log`.

This closes the two-viewer test issue, not M2 as a whole. Calibration and pixel-oracle acceptance
remain pending. The oracle now explicitly requires a complete 500-trial calibration for both
scales and copies it into the test daemon's private home, so a missing or partial table cannot
silently use fallback onset values.
