# Evidence for a change

Start with the concrete failure and test at the boundary where it occurs. Test success, one representative failure, cancellation/retry if asynchronous, and backward compatibility if a protocol changed. Prefer assertions on user-visible state, requests or persistent data rather than snapshots of implementation text.

Use the repository’s formatter, types, targeted tests and required CI checks. Broaden only where the change touches shared behavior. For UI work use role/label locators, deterministic fixtures and an actual visible preview. Inspect the narrowest supported viewport, long text, empty/loading/error states, keyboard focus and scroll reachability. Use a recording or trace for intermittent races; do not add arbitrary sleeps to make a test pass.

Measure performance with representative data and hardware: render cost, requests, memory, long tasks and list size. Compare before/after under the same conditions; do not claim speedups from a single noisy timing. Inspect pagination, virtualization and retained event listeners before micro-optimizing.

Review the final diff against the request and verify it contains only intended files. Respect repository release checks and existing user authorization. If publishing was requested, verify the installed/downloaded artifact and update channel, not only a successful build or uploaded tag.
