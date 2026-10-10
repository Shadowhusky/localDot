# keyd

keyd is localDot's key layer: it stores real credentials and issues scoped API-key stand-ins. It keeps its state in
`<home>/keyd`, answers the daemon on `<home>/keyd/admin.sock` and stores secret values as Keychain
items whose access list trusts only keyd of generation 2 or later, signed by team `87FD3FSZBG`.

## Saved browser logins

Browser account/password pairs use the same protected store, in a reserved `login-` namespace
bound to the exact HTTPS origin. They are not listed as API keys or issued as surrogates. The
daemon saves and retrieves them over the private admin socket, then delivers them through the
browser's protected input channel; values do not enter model input, conversation events or audit
payloads. One login is stored per origin. Browser sign-out clears cookies separately from these
saved passwords. See [browser sign-ins](../docs/browser-workspace.md#sign-in-once).

## Two binaries

| Binary | Signing identifier | What it does |
| --- | --- | --- |
| `keyd` | `dev.localdot.keyd` | The daemon, its Keychain item helper (`keychain-item`), the install, service and canary locks, `verify-audit`, `self-test` and `requirement`. |
| `keyd-native` | `dev.localdot.keyd.native` | `native-run`, the daemon's task launcher, and `native-lock`. |

Both are signed with the Developer ID, the hardened runtime and no entitlements. keyd is also
signed with an explicit designated requirement, which `keyd requirement` prints: the identifier,
the team and `info [KeydGeneration] >= "2"`. Its Info.plist (`internal/keydinfo`) carries the
generation. See [Signing a release keyd](#signing-a-release-keyd).

## Who can use the Keychain items

Earlier keyd builds had a subcommand that started a program its caller named, as keyd's child,
and any copy of one still has it. They meet only the earlier requirement (identifier and team), so
nothing generation 2 stores, and nothing it adopts, is readable by them:

- The Keychain item helper (`keyd keychain-item`) checks that it is generation 2 keyd, that its
  parent is generation 2 keyd, and that its parent was started as the daemon (flags only). `keyd
  self-test` may run the identity check alone, which opens no keychain.
- Each start of the daemon makes a secret and claims the Keychain service with it: the claim, an
  item only keyd reads, records the daemon's process, when it started and the secret's digest. The
  daemon hands the secret to every helper it runs on descriptor 3. An item operation runs only for
  the daemon that holds the claim, with that secret. A second keyd daemon, whatever its home,
  cannot claim the service while the first runs.
- At start, after its claim, keyd adopts every item stored under the earlier requirement. keyd
  meets that requirement too, so it reads each value, stages it in an item only it can read,
  deletes the item and makes it again under its own access list. A move cut short is put back at
  the next start. An item keyd cannot read or move, such as one whose partition list does not name
  keyd's team, stays as it is and the next start tries it again; every other item still moves, and
  the audit line counts the items left behind. An item's access list is never changed in place:
  that would need you at a Keychain prompt for each item.
- An item whose access list is neither keyd's nor the earlier keyd's is refused as not keyd's, and
  the key is listed as one to enter again; storing or removing the key replaces the item.

The helper refuses every other caller: a direct call, a call through `keyd-native native-run`, a
shell, any other keyd subcommand, or a keyd daemon without the claim. It checks its parent before
it reads anything the parent sends, so a refused caller is never kept waiting on its input. The launcher lives in
`keyd-native`, so nothing it starts can pass as keyd's child.

## Commands

```sh
make build            # bin/keyd and bin/keyd-native, unsigned
make test             # go test ./...
make deploy-dry-run   # build, sign, verify, self-test, then print the switch
make deploy           # the same, then switch the hand-run keyd
```

## Deploying the hand-run keyd

`scripts/deploy.sh` replaces the keyd that the LaunchAgent `dev.localdot.keyd` runs. It reads the
binary's path and its home (`-home`, `--home`, either with `=`, or `LOCALDOT_HOME` in the agent's
environment) from `~/Library/LaunchAgents/dev.localdot.keyd.plist`; use `--target` and `--label` to
point it elsewhere. It works through these steps:

1. Builds both binaries and the test executables of `cmd/keyd` and `internal/vault` into a
   temporary folder, and checks that keyd carries its Info.plist and names the generation
   requirement.
2. Signs them with `Developer ID Application: Richard Liao (87FD3FSZBG)`, using the hardened
   runtime and a secure timestamp. keyd and the two test executables get keyd's identifier and its
   designated requirement, so that the tests pass as keyd's daemon; they never leave the temporary
   folder.
3. Verifies each signature against its requirement, keyd's designated requirement, the hardened
   runtime flag, the absence of entitlements and the local Gatekeeper source ("Unnotarized
   Developer ID" is expected). It also checks that neither binary is quarantined and that
   keyd-native does not meet keyd's requirement. launchd starts keyd without a Gatekeeper check, so
   notarization is not needed.
4. Runs the self-test and the signed tests:
   - `keyd self-test` in a temporary home. The helper accepts signed keyd, and a memory-vault
     daemon answers its admin socket.
   - A direct call of the helper is refused.
   - `cmd/keyd`: the helper serves this signed daemon only with its secret, and refuses a signed
     daemon without the channel, a signed keyd running a subcommand, a shell, `keyd-native`,
     another daemon's claim and every operation without the claim. The claim probes use a keychain
     the test makes.
   - `internal/vault`: the binding migration runs through the native helper against a keychain the
     test makes: a proven item, a planted item, a second start, a migration cut short, a record
     changed outside keyd and a start without a marker over a bound item. Adopt moves past items
     it cannot read. When the live keyd is from before generation 2, the legacy items get its
     access list and keyd adopts them first.
5. Stages `.keyd.next` and `.keyd-native.next` next to the live keyd and verifies them again.
6. Keeps the running binaries as `keyd.prev` and `keyd-native.prev`, renames the new ones into
   place and runs `launchctl kickstart -k gui/<uid>/dev.localdot.keyd`. If that fails, it rolls
   back.
7. Waits up to 20 seconds for keyd to become healthy:
   - launchd runs the new binary's cdhash.
   - `/v1/status` answers with a new boot ID and an intact audit log.
   - The process is still the same two seconds later.

   Once keyd is healthy, the `.prev` binaries are deleted, and the script prints how many keys
   need entering again and how many were changed outside localDot. If keyd does not get there,
   the script renames the previous binaries back, restarts keyd and exits 1. Items the new keyd
   adopted at its start stay readable only by keyd of generation 2 or later.

`--dry-run` stops after step 4 and prints steps 5 to 7. If signing fails with
`errSecInternalComponent`, the login keychain is locked or the signing key is waiting for your
approval.

## Signing a release keyd

A release keyd is signed as `scripts/deploy.sh` signs it, with keyd's requirement as its
designated requirement:

```sh
codesign --force --sign "Developer ID Application: Richard Liao (87FD3FSZBG)" \
  --identifier dev.localdot.keyd --options runtime --timestamp \
  --requirements "=designated => $(bin/keyd requirement)" bin/keyd
```

Without `--requirements`, keyd still meets that requirement, but its designated requirement is the
implicit one. The items keyd stores trust its designated requirement, so they would not be keyd's
and keyd would refuse to start. Release verification (`apps/cli/src/install/keyd-verification.ts`)
refuses such a build: the designated requirement must be exactly the one `keyd requirement`
prints. keyd-native is signed without `--requirements`.
