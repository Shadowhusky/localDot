# keyd

keyd is localDot's key layer: the only process that holds real secrets. It keeps its state in
`<home>/keyd`, answers the daemon on `<home>/keyd/admin.sock` and stores secret values as Keychain
items whose access list trusts only code signed as `dev.localdot.keyd` by team `87FD3FSZBG`.

## Two binaries

| Binary | Signing identifier | What it does |
| --- | --- | --- |
| `keyd` | `dev.localdot.keyd` | The daemon, its Keychain item helper (`keychain-item`), the install, service and canary locks, `verify-audit` and `self-test`. |
| `keyd-native` | `dev.localdot.keyd.native` | `native-run`, the daemon's task launcher, and `native-lock`. |

Both are signed with the Developer ID, the hardened runtime and no entitlements.

The Keychain item helper is `keyd keychain-item`, a short-lived child of keyd. Before it opens a
keychain it checks three things: that it is signed keyd, that its parent is signed keyd, and that
its parent was started as the daemon (flags only). `keyd self-test` may also run the identity
check, which opens no keychain. It refuses every other caller: a direct call, a call through
`keyd-native native-run`, a shell, or any other keyd subcommand. keyd has no subcommand that
starts a program its caller names. The launcher lives in `keyd-native`, so nothing it starts can
pass as keyd's child.

Item access lists still trust any `dev.localdot.keyd` signature, including builds from before this
split. An item's owner entry is prompt-only, so moving items to a new signing requirement needs
the user to approve it at a Keychain prompt. That is a separate, user-run step. Until it is done,
delete old signed keyd builds (such as `keyd.prev` after a deploy) once the new one is confirmed.

## Commands

```sh
make build            # bin/keyd and bin/keyd-native, unsigned
make test             # go test ./...
make deploy-dry-run   # build, sign, verify, self-test, then print the switch
make deploy           # the same, then switch the hand-run keyd
```

## Deploying the hand-run keyd

`scripts/deploy.sh` replaces the keyd that the LaunchAgent `dev.localdot.keyd` runs. It reads the
binary's path and `-home` from `~/Library/LaunchAgents/dev.localdot.keyd.plist`; use `--target` and
`--label` to point it elsewhere. It works through these steps:

1. Builds both binaries into a temporary folder.
2. Signs them with `Developer ID Application: Richard Liao (87FD3FSZBG)`, using the hardened
   runtime and a secure timestamp.
3. Verifies each signature against its designated requirement, the hardened runtime flag, the
   absence of entitlements and the local Gatekeeper source ("Unnotarized Developer ID" is
   expected). It also checks that neither binary is quarantined. launchd starts keyd without a
   Gatekeeper check, so notarization is not needed.
4. Runs the self-test:
   - `keyd self-test` in a temporary home. The helper accepts signed keyd, and a memory-vault
     daemon answers its admin socket.
   - A direct call of the helper is refused.
   - The signed gate test (`KEYD_SIGNED_DIR=… go test ./cmd/keyd`) shows the helper refusing a
     call through `keyd-native`.
5. Stages `.keyd.next` and `.keyd-native.next` next to the live keyd and verifies them again.
6. Keeps the running binaries as `keyd.prev` and `keyd-native.prev`. It renames the new ones into
   place and runs `launchctl kickstart -k gui/<uid>/dev.localdot.keyd`.
7. Waits up to 20 seconds for keyd to become healthy:
   - launchd runs the new binary's cdhash.
   - `/v1/status` answers with a new boot ID and an intact audit log.
   - The process is still the same two seconds later.

   If keyd does not get there, the script renames the previous binaries back, restarts keyd and
   exits 1.

`--dry-run` stops after step 4 and prints steps 5 to 7. If signing fails with
`errSecInternalComponent`, the login keychain is locked or the signing key is waiting for your
approval.
