# Keyd interception verification — 2 October 2026

The gateway terminates TLS only for hosts in the cell's in-memory, name-constrained CA. It requires the CONNECT host, SNI and inner HTTP authority to agree, inspects each request, swaps an allowed surrogate, and scrubs reflected credentials in response bodies, headers, trailers and informational responses. Other allowed hosts retain the SNI-checked passthrough path.

The implementation closes bound hosts that lack an inspection CA. Both HTTP listeners limit headers to 64 KiB (with net/http's parsing slack), and use the same ASCII host comparison. `OPTIONS *` reaches policy and audit handling inside TLS. Revocation and Close end an idle intercepted TLS connection as well as active requests.

Verification on Darwin/arm64, Go 1.27.1:

- All ten Go packages passed `go test -race ./...`.
- All twenty interception test functions passed ten repeated race runs, including the added header-size, ASCII/port, `OPTIONS *`, absolute-target surrogate and idle tunnel cases.
- Fourteen deliberate mutations were caught by their regression tests: selective interception, SNI, raw-connection ownership, inner host and absolute URL checks, surrogate alerts, the header cap, `OPTIONS *` handling, ports, Unicode folding, upstream certificate verification, inspection, audit failure handling, and upgrade refusal. The port mutation was corrected after an initial variant failed to compile, then its executing test caught the change.
- `go vet ./...`, gofmt and `go mod tidy -diff` passed.

The wire tests use local TLS upstreams and a guarded resolver/dialer. They make no provider calls and contain only test credentials. This verifies the interception layer; LLM accounting, admin integration and the browser key interface remain separate milestones.
