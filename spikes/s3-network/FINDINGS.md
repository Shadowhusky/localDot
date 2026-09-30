# S3 findings: internal networks and gate relays

2026-09-30 · macOS 26.6.2 arm64 · Docker Desktop 4.60.0 (Engine 29.2.0, iptables backend, default
network settings) · Node 25.6.0

**Result: GO.** The planned topology works unchanged; the Step 5 fallback did not apply.

- **Listener bind address keyd must use: `127.0.0.1`.** A gate's `host.docker.internal:<port>`
  reaches a Mac listener bound to `127.0.0.1`.
- **Working topology** (as `run.sh` builds it): the cell is only on an `--internal` network; its
  gate is on that network plus its own egress network, relays with socat
  (`3128=host.docker.internal:4799`, `8081=ld-s3-cell:8080`) and publishes only
  `-p 127.0.0.1:4798:8081`.
- **Per-gate egress networks isolate gates**, by IP as well as by name: from `ld-s3-gate`,
  `nc -z -w 3` to gate2's `172.27.0.2:3128` (egress) and `172.26.0.2:3128` (internal) time out,
  while `nc -z -w 3 172.27.0.2 3128` inside gate2 and `nc -z -w 3 ld-s3-cell 8080` from the gate
  exit 0. socat listens on every gate interface, so keep exactly one gate per egress network.
- **The cell is cut off by routing, not only DNS:** its only route is `172.24.0.0/16 dev eth0`, and
  `curl` to `1.1.1.1` or `192.168.65.254:4799` fails `after 0 ms: Could not connect to server`.
  `nslookup example.com` gets `SERVFAIL` (exit 1) while `nslookup ld-s3-gate` resolves (exit 0).
- **Loopback only:** `lsof` shows just `127.0.0.1:4798` (Docker) and `127.0.0.1:4799` (node)
  listening.

## Runs of `spikes/s3-network/run.sh` (LISTEN_ADDR=127.0.0.1)

Run 1 (17:45 BST, first build; exit 0, 8.8 s):
```
host listener on 127.0.0.1:4799
ok    blocked  cell -> internet (https://example.com)
ok    blocked  cell -> external DNS (nslookup example.com)
ok    blocked  cell -> host.docker.internal directly
ok    ok       cell -> gate -> host listener (127.0.0.1)
ok    ok       host -> 127.0.0.1:4798 -> gate -> cell
ok    blocked  LAN 192.168.1.241:4798 -> gate
ok    blocked  cell -> another sandbox's gate
ok    blocked  gate -> another sandbox's gate (separate egress networks)
failures: 0
```
Run 2 (17:48 BST, cached build; exit 0, 5.6 s):
```
host listener on 127.0.0.1:4799
ok    blocked  cell -> internet (https://example.com)
ok    blocked  cell -> external DNS (nslookup example.com)
ok    blocked  cell -> host.docker.internal directly
ok    ok       cell -> gate -> host listener (127.0.0.1)
ok    ok       host -> 127.0.0.1:4798 -> gate -> cell
ok    blocked  LAN 192.168.1.241:4798 -> gate
ok    blocked  cell -> another sandbox's gate
ok    blocked  gate -> another sandbox's gate (separate egress networks)
failures: 0
```

## Docker Desktop surprises

1. `host.docker.internal` also has an IPv6 ULA, `fdc4:f303:9324::254`, which musl `getent hosts`
   prints first although these networks have no IPv6; socat dials the A record `192.168.65.254`.
2. Relayed connections reach the host from `127.0.0.1` (`host-ok from 127.0.0.1:52936`), so keyd
   cannot tell cells apart by source address, only by listener port or credential.
3. Any container on a non-internal network reaches host loopback (gate2 ran
   `wget -qO- http://host.docker.internal:4799` and got `host-ok`); only `--internal` keeps a cell
   away from host services.

The extra checks above ran once on the same topology (a scratch copy of `run.sh`'s setup). No
`ld-s3-*` container, network or listener remained after any run; both images stay for Task 6.
