# S3 findings: internal networks and gate relays

2026-09-30 · macOS 26.6.2 arm64 · Docker Desktop 4.60.0 (Engine 29.2.0) · Node 25.6.0 ·
`run.sh` blob `8e96ae7e`

**Result: GO-WITH-CHANGES.** Every sandbox network (the orchestrator's and Task 6's) must be
created with
`docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`.
With plain `--internal` (run 1) the cell reached VM listeners 55139 and 111 via its bridge gateway
`172.24.0.1`, the only VM address inside its sole route `172.24.0.0/16`. In isolated mode (run 2)
Engine 29.2 accepts the option, the sandbox bridges get no IPv4 and every probe passes.

- **Listener bind address keyd must use: `127.0.0.1`** (`cell -> gate -> host listener` is `ok`).
- **Working topology:** the cell is only on an isolated-gateway `--internal` network; its gate is on
  that network plus its own egress network, relays with socat and publishes only
  `-p 127.0.0.1:4798:8081`.
- **Per-gate egress isolation: yes, by IP.** `gate -> gate2 <ip>:3128 by IP` is `blocked` for both
  gate2 addresses while the `gate2 relay listening` and `gate nc -z` controls are `ok`; the brief's
  name-based lines only prove that names don't resolve across networks.
- **Controls:** every `blocked` line except the LAN probe has an `ok` control on the same tool or
  target. For the VM-listener lines the control is the third `info` line: only listeners that accept
  from inside the VM are probed (18790 and 3978 accept nothing, so they are skipped).

## Docker Desktop surprises

1. Plain `--internal` doesn't wall off the Docker Desktop VM: the bridge gateway is a VM address and
   VM listeners on `0.0.0.0` answer on it. In isolated mode the first container takes `.1` and
   Docker reports the gateway as `invalid IP`.
2. `host.docker.internal` also resolves to an IPv6 ULA (`fdc4:f303:9324::254`), listed first in
   run 1; don't assume the first address is IPv4.
3. Containers with egress reach host loopback (`control: gate -> 192.168.65.254:4799` hits the
   `127.0.0.1` listener). Only the internal network keeps a cell away from host services.

## Run 1: `spikes/s3-network/run.sh` (plain `--internal`; 18:28:04 BST; exit 2, 22.3 s)
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
info  gate resolves host.docker.internal to: fdc4:f303:9324::254 192.168.65.254
ok    blocked  cell -> 1.1.1.1:443 by IP
ok    ok       control: gate -> 1.1.1.1:443 by IP
ok    blocked  cell -> 192.168.65.254:4799 by IP (host.docker.internal)
ok    ok       control: gate -> 192.168.65.254:4799 by IP
ok    ok       control: gate2 relay listening (127.0.0.1:3128)
ok    ok       control: gate nc -z -> ld-s3-cell:8080
ok    blocked  cell -> gate2 172.26.0.2:3128 by IP
ok    blocked  gate -> gate2 172.26.0.2:3128 by IP
ok    blocked  cell -> gate2 172.27.0.2:3128 by IP
ok    blocked  gate -> gate2 172.27.0.2:3128 by IP
info  cell routes: 172.24.0.0/16 dev eth0 scope link src 172.24.0.2
info  sandbox gateway: 172.24.0.1; VM IPv4 addresses: 192.168.65.3 192.168.65.6 172.23.0.1 172.20.0.1 172.19.0.1 172.21.0.1 172.17.0.1 172.18.0.1 172.22.0.1 172.24.0.1 172.25.0.1 172.26.0.1 172.27.0.1
info  VM TCP listeners on 0.0.0.0: 4416 55139 111 18789 18790 3978 3120 3457; accepting from inside the VM: 4416 55139 111 18789 3120 3457
ok    ok       control: cell nc -z -> ld-s3-gate:3128
ok    blocked  cell -> any VM address on 22 53 80 443 2375 3128 4798 6443
ok    blocked  cell -> any VM address on VM listener 4416
FAIL  ok       cell -> any VM address on VM listener 55139 (wanted blocked)
FAIL  ok       cell -> any VM address on VM listener 111 (wanted blocked)
ok    blocked  cell -> any VM address on VM listener 18789
ok    blocked  cell -> any VM address on VM listener 3120
ok    blocked  cell -> any VM address on VM listener 3457
ok    blocked  cell -> DNS server on any VM address
ok    ok       control: cell nslookup ld-s3-gate (embedded DNS)
failures: 2
```
## Run 2: `GATEWAY_MODE=isolated spikes/s3-network/run.sh` (18:28:34 BST; exit 0, 13.6 s)
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
info  gate resolves host.docker.internal to: 192.168.65.254 fdc4:f303:9324::254
ok    blocked  cell -> 1.1.1.1:443 by IP
ok    ok       control: gate -> 1.1.1.1:443 by IP
ok    blocked  cell -> 192.168.65.254:4799 by IP (host.docker.internal)
ok    ok       control: gate -> 192.168.65.254:4799 by IP
ok    ok       control: gate2 relay listening (127.0.0.1:3128)
ok    ok       control: gate nc -z -> ld-s3-cell:8080
ok    blocked  cell -> gate2 172.26.0.1:3128 by IP
ok    blocked  gate -> gate2 172.26.0.1:3128 by IP
ok    blocked  cell -> gate2 172.27.0.2:3128 by IP
ok    blocked  gate -> gate2 172.27.0.2:3128 by IP
info  cell routes: 172.24.0.0/16 dev eth0 scope link src 172.24.0.1
info  sandbox gateway: invalid IP; VM IPv4 addresses: 192.168.65.3 192.168.65.6 172.23.0.1 172.20.0.1 172.19.0.1 172.21.0.1 172.17.0.1 172.18.0.1 172.22.0.1 172.25.0.1 172.27.0.1
info  VM TCP listeners on 0.0.0.0: 4416 55139 111 18789 18790 3978 3120 3457; accepting from inside the VM: 4416 55139 111 18789 3120 3457
ok    ok       control: cell nc -z -> ld-s3-gate:3128
ok    blocked  cell -> any VM address on 22 53 80 443 2375 3128 4798 6443
ok    blocked  cell -> any VM address on VM listener 4416
ok    blocked  cell -> any VM address on VM listener 55139
ok    blocked  cell -> any VM address on VM listener 111
ok    blocked  cell -> any VM address on VM listener 18789
ok    blocked  cell -> any VM address on VM listener 3120
ok    blocked  cell -> any VM address on VM listener 3457
ok    blocked  cell -> DNS server on any VM address
ok    ok       control: cell nslookup ld-s3-gate (embedded DNS)
failures: 0
```

No `ld-s3-*` container, network or listener remained after either run.
