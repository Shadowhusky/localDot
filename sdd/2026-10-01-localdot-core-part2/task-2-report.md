# Task 2 report: Desktop image with a pinned base, the app set, Node, VSCodium and Cua Driver

**Status: DONE_WITH_CONCERNS** (the concerns are non-blocking design notes on the brief; every
Run/Expected step passed as written)
Commit: `af56e5a feat(desktop): pinned desktop image with the app set, Node, VSCodium and Cua Driver`
(on `feat/core-part2`, parent `6d6f019`; empty body, no attribution line).

## What I implemented

- **Step 1, base digest.** `docker image inspect --format '{{index .RepoDigests 0}}'
  lscr.io/linuxserver/webtop:ubuntu-xfce` printed
  `lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`,
  the same as the brief's value, so the commit message carries no note.
- **Step 2, Cua Driver pins.** I generated `cells/desktop/cua-requirements.txt` with the brief's exact
  command in the throwaway `localdot-cua-pins` container of the pinned base. The file came out with
  `docker cp`, and the container was removed with `docker rm -fv`. Details are under "Generated pins".
- **Step 3.** `cells/desktop/Dockerfile`, `cells/desktop/.dockerignore` and
  `cells/desktop/build.sh` are verbatim from the brief, and `build.sh` is committed as 100755. A
  mechanical `diff` of the brief's dockerfile block against the committed Dockerfile prints nothing.
  The image `localdot/desktop:dev` was built with `cells/desktop/build.sh`.
- **Step 4.** `apps/daemon/src/cells/desktop-image.docker.test.ts` is the brief's code. The only
  change is biome's wrap of the one line over 100 columns (the `readlink` assertion): the brief's
  block, run through `biome format`, is byte-identical to the committed file.
- **Not in the brief's steps, verification only.** I built the `selkies-client` stage to a local
  directory in my scratchpad (`docker build --target selkies-client -o type=local,...`). This
  creates no image or container. It ran only its 4 `COPY --from` steps and never built the base
  stage. Its output has `index.html`, `assets/` (3 files: `index-CPWh3fQ6.js`,
  `index-D97fjY6g.css`, `selkies-core-BbKps5RD.js`), `icon.png` (PNG, 180×180), `icon-512.png`
  (PNG, 512×512) and `LICENSE` (starts "Mozilla Public License Version 2.0").

### Upstream checksum cross-checks, done before the build

- **Node.** `nodejs.org/dist/v24.21.0/SHASUMS256.txt` lists `6ad1325e…289ad2` (linux-arm64) and
  `fd8e59d5…cb2d6` (linux-x64). Both equal the brief's ARGs.
- **VSCodium.** The release's `codium_1.135.06055_{arm64,amd64}.deb.sha256` files hold `79d1efcb…8a14`
  and `5f5c00a9…8649`. Both equal the brief's ARGs.
- **Cua Driver.** PyPI's JSON for cua-driver 0.30.4 gives
  `cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl` the sha256
  `9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08`, the hash the pin generation
  computed. `requires_dist` is only `pytest; extra == "test"`, so the closure is one wheel.

## Generated pins (Step 2)

`pip download --only-binary=:all:` saved one wheel:
```
Collecting cua-driver==0.30.4
  Downloading cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl.metadata (8.9 kB)
Downloading cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl (32.6 MB)
Saved /tmp/wheels/cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl
Successfully downloaded cua-driver
```
`cells/desktop/cua-requirements.txt` (2 lines, LF, trailing newline):
```
# cua-driver 0.30.4 and its dependency closure for linux/arm64, every wheel pinned by sha256
cua-driver==0.30.4 --hash=sha256:9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08
```
Checks: 1 requirement line, and 0 requirement lines without a ` --hash=sha256:<64 hex>`.

## Build (Step 3)

`BUILDKIT_PROGRESS=plain cells/desktop/build.sh` passed with exit 0. The environment variable only
makes the log plain text; `build.sh` is unchanged. The steps took about 75 s in all, not the 10–25
minutes the brief expected: apt 24.7 s, Node 2.4 s, VSCodium 12.3 s, pip 2.4 s, export 28.4 s.
The log has the expected lines:
```
#9 0.667 /tmp/node.tar.xz: OK
#10 3.206 /tmp/codium.deb: OK
#12 1.427 Collecting cua-driver==0.30.4 (from -r /opt/cua/requirements.txt (line 2))
#12 1.469   Downloading cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl (32.6 MB)
#12 2.152 Successfully installed cua-driver-0.30.4
```
- `docker image ls localdot/desktop` lists `localdot/desktop:dev`, 7.21 GB on disk (the base is
  4.61 GB).
- Its platform manifest is `sha256:18d22527474f…` and its config `sha256:bb622abf21c5…`.

### Tamper check: the hashes bind

I ran the brief's commands, except that `mktemp` wrote to my scratchpad instead of `$TMPDIR`. The
tampered build stopped at the Cua Driver step. The steps before it came from the cache:
```
#12 2.164 ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE. If you have updated the package versions, please update the hashes. Otherwise, examine the package contents carefully; someone may have tampered with them.
#12 2.164     cua-driver==0.30.4 from https://files.pythonhosted.org/packages/93/7c/e50cb74829066b64077f70f171c9a62757b54f04108466825944df33d6ff/cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl (from -r /opt/cua/requirements.txt (line 2)):
#12 2.164         Expected sha256 0000000000000000000000000000000000000000000000000000000000000000
#12 2.164              Got        9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08
ERROR: failed to build: failed to solve: process "/bin/sh -c python3 -m venv /opt/cua  && /opt/cua/bin/pip install --no-cache-dir --require-hashes ..." did not complete successfully: exit code: 1
refused, as it should be
```
After the restore, the second build passed from the cache. Every step (`#8`–`#12`) shows
`CACHED`, then `naming to docker.io/localdot/desktop:dev done` and `restored build exit=0`.
`cmp` confirmed that the restored file is byte-identical to the generated pins.

- **The image ID changed, but the image did not.** It went from `325626d3948d` to `c70d0d8f34ae`
  after the cached rebuild. The platform manifest and config digests are identical in both builds.
  Only Docker Desktop's provenance attestation differs, because it records build metadata, and
  that changes the manifest-list digest that is shown as the image ID.
- **No dangling image is left.** `docker image ls --filter dangling=true` is empty.

## Tests and results (TDD evidence)

### RED 1: the precondition fails before the image exists

Command: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
(before Step 3)
```
 FAIL  apps/daemon/src/cells/desktop-image.docker.test.ts > desktop image: pinned tools
Error: localdot/desktop:dev is missing: run cells/desktop/build.sh first
 Test Files  1 failed (1)
      Tests  5 skipped (5)
```
This is expected: there was no image yet, and `beforeAll` refuses to run without one.

### RED 2: a behavioural failure on every test

RED 1 only exercises the precondition. To see each test fail on what it checks, I tagged the bare
pinned base as `localdot/desktop:dev` and ran the same command. The build later moved that tag to
the real image, and the base keeps its own tag.
```
 ❯ apps/daemon/src/cells/desktop-image.docker.test.ts (5 tests | 5 failed) 618ms
     × ships the app set            -> exec: "libreoffice": executable file not found in $PATH
     × ships Node 24.21.0           -> exec: "node": executable file not found in $PATH
     × runs Cua Driver 0.30.4 …     -> exec: "cua-driver": executable file not found in $PATH
     × has Inter, JetBrains Mono …  -> expected 'Noto Sans Gurmukhi\nNoto Sans Display…' to match /\bInter\b/
     × has the X, accessibility …   -> xinput: expected 127 to be +0
      Tests  5 failed (5)
```
This is expected: the base has none of the tools this task adds. Cleanup worked too:
`docker ps -a --filter name=localdot-test` was empty afterwards.

### GREEN

Same command, after the build:
```
 ✓ … > desktop image: pinned tools > ships the app set 1178ms
 ✓ … > desktop image: pinned tools > ships Node 24.21.0 155ms
 ✓ … > desktop image: pinned tools > runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off 111ms
 ✓ … > desktop image: pinned tools > has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji 66ms
 ✓ … > desktop image: pinned tools > has the X, accessibility and certificate tools 275ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  2.27s
```
It passed on two separate runs, and the output is clean.

### What the probes actually print

I checked these by hand in a throwaway `localdot-test-desktop-probe` container, removed with `-fv`,
to rule out vacuous passes:
- **VSCodium, as `abc`:** `1.135.06055` / `1a46a584725d5dd330e0bcd7f5510f24990efcf2` / `arm64`.
- **Cua Driver, as `abc`:** `cua-driver 0.30.4`. `/usr/local/bin/cua-driver` links to
  `/opt/cua/lib/python3.14/site-packages/cua_driver/bin/cua-driver`.
- **Node:** `v24.21.0`, with npm and npx 11.19.0 through the `/usr/local/bin` links.
  `/usr/local/bin/node` resolves to `/opt/node/bin/node`.
- **Apps:**
  - LibreOffice 26.2.5.2
  - GIMP 3.2.2
  - ffmpeg 8.0.1-3ubuntu2
  - ImageMagick 7.1.2-18 (`convert` still exists)
  - pandoc 3.7.0.2
  - Chromium 154.0.8037.57, from `chromium-browser` run as root
- **`python3` is not the system Python.** On the image's PATH it is linuxserver's `/lsiopy` venv,
  which was built with `--system-site-packages`. I checked whether that made `import Xlib` vacuous.
  It doesn't: the bare base has no Xlib under either interpreter. In our image, both `python3` and
  `/usr/bin/python3` load it from the apt package's `/usr/lib/python3/dist-packages/Xlib`.
- **`/opt/cua` is effectively the system Python.** It was created by `/lsiopy/bin/python3 -m venv`,
  but its `pyvenv.cfg` says `home = /usr/bin`, Python 3.14.4, and
  `include-system-site-packages = false`.

### Other checks, all on the committed tree

- `pnpm format`: "No fixes applied". The first run wrapped the one long line in the test.
- `pnpm lint`: "Checked 59 files … No fixes applied."
- `pnpm typecheck`: all 4 projects Done.
- `pnpm hygiene`: exit 0.
- `pnpm test` (no Docker): 16 files and 145 tests passed.

## Files changed (commit af56e5a)

```
 apps/daemon/src/cells/desktop-image.docker.test.ts | 68 +++++  (new)
 cells/desktop/.dockerignore                        |  4 +    (new)
 cells/desktop/Dockerfile                           | 80 +++++  (new)
 cells/desktop/build.sh                             |  5 +    (new, mode 100755)
 cells/desktop/cua-requirements.txt                 |  2 +    (new)
```

## Self-review findings

- **Complete against the brief.** All six steps are done, and every Expected was met:
  - the digest matches;
  - the pins file has a comment line plus hashed lines only;
  - both checksum lines print `OK`;
  - pip installs in hash-checking mode;
  - the tamper build is refused and the restored build comes from the cache;
  - all 5 tests pass.
- **Interface.**
  - The `desktop` stage produces `localdot/desktop:dev`.
  - The `selkies-client` stage holds the five promised items.
  - Node, Cua Driver and `codium` are where the brief says.
  - All six ENV values are present in the image config, including `GTK_MODULES=gail:atk-bridge`
    and `QT_ACCESSIBILITY=1`, which the test doesn't assert.
- **Quality and YAGNI.** No code beyond the brief. The Dockerfile comments are the brief's own.
- **Tests verify behaviour.** RED 2 shows each test failing against an image without the feature.
  The Xlib check was confirmed to discriminate.
- **Docker hygiene, final state:**
  - `docker ps -a --filter name=localdot-test`: header only.
  - `docker ps -a --filter name=localdot-cua-pins`: header only.
  - `docker network ls --filter name=localdot-test`: header only.
  - `docker volume ls --filter dangling=true`: 23 volumes, the same 23 names as my pre-task
    snapshot (`comm` shows none new and none gone).
  - The `localdot-cua-pins` container and every `localdot-test-desktop-*` container were removed
    with `-fv`, which also took the base's anonymous `/config` volume.
  - Nothing was pruned and no other project's resources were touched. No path under the SSD was
    bind-mounted: the pins came out with `docker cp`, and the build used the context.
- **Images I created:** `localdot/desktop:dev`, the deliverable. The temporary RED tag on the base
  was replaced by the build.

## Issues and concerns for the controller

1. **The pins are arm64-only, so an amd64 build would stop at the Cua Driver step.**
   - The brief generates the pins for the host architecture, by design. But the Dockerfile has
     `amd64` branches for Node and VSCodium, which suggests amd64 builds are meant to work.
   - On an amd64 host, pip would refuse the `manylinux_2_31_x86_64` wheel with a hash mismatch.
   - Nothing breaks today, because CI (`.github/workflows/ci.yml`) builds no images.
   - If amd64 matters, pip accepts several hashes on one requirement. PyPI's x86_64 wheel is
     `e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b`, so the line would become
     `cua-driver==0.30.4 --hash=sha256:9d7c…3f08 --hash=sha256:e8cd…864b`.
   - I left the file as the brief's procedure generated it.
2. **Minor: the `# syntax=docker/dockerfile:1` line pulls an unpinned BuildKit frontend from Docker
   Hub on every build.**
   - This build resolved it to
     `docker.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e`.
   - It is not a base image, but it is downloaded code outside the "pinned by digest" policy.
   - Two ways to close the gap: pin it as `# syntax=docker/dockerfile:1@sha256:4edf…e99e`, or drop
     the line, since the engine's built-in frontend handles everything this Dockerfile uses.
   - Kept verbatim.
3. **Observations for later tasks, no action needed now.**
   - **apt sources in the base.** The base ships sources for `deb.nodesource.com/node_22.x`,
     `download.docker.com` and the xtradeb PPA. Any later `apt-get install` that pulls in `nodejs`
     would add Node 22 at `/usr/bin/node`. The pinned Node still wins, because `/usr/local/bin`
     comes first in PATH.
   - **Which `python3`.** `python3` on PATH is `/lsiopy/bin/python3`, which sees the system
     site-packages. Tasks that run Python helpers as the desktop user get the apt modules either way.

## Fix report: controller rulings on concerns 1 and 2

**Status: DONE.** Both rulings are applied, and concerns 1 and 2 are resolved.
Commit: `3bc926e fix(desktop): pin the Dockerfile frontend by digest and hash the amd64 Cua Driver wheel`.
It is a new commit on top of `af56e5a`, with no amend and no attribution.

### What changed

```diff
--- a/cells/desktop/Dockerfile
+++ b/cells/desktop/Dockerfile
-# syntax=docker/dockerfile:1
+# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
--- a/cells/desktop/cua-requirements.txt
+++ b/cells/desktop/cua-requirements.txt
-# cua-driver 0.30.4 and its dependency closure for linux/arm64, every wheel pinned by sha256
-cua-driver==0.30.4 --hash=sha256:9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08
+# cua-driver 0.30.4 and its dependency closure for linux/arm64 and linux/amd64, every wheel pinned by sha256
+cua-driver==0.30.4 --hash=sha256:9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08 --hash=sha256:e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b
```

- **Ruling 1: frontend pin.**
  - The full index digest is
    `sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e`.
  - `docker buildx imagetools inspect docker/dockerfile:1` confirmed it is the same digest the first
    build resolved:
    ```
    Name:      docker.io/docker/dockerfile:1
    MediaType: application/vnd.oci.image.index.v1+json
    Digest:    sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
      ...
      Name:        docker.io/docker/dockerfile:1@sha256:e291cde6b1429712d3951bca77be92338719212df6654812f1a55874a481742d
      Platform:    linux/arm64
    ```
  - The line is kept and pinned, not dropped.
- **Ruling 2: x86_64 wheel hash.** The hash is `e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b`.
  - It is the second `--hash` on the `cua-driver==0.30.4` line, so the arm64 hash stays first.
    That order matters: the brief's tamper `sed` has no `g` flag and zeroes only the first hash on
    the line (re-run below).
  - **Checked against PyPI JSON:** `https://pypi.org/pypi/cua-driver/0.30.4/json`. It lists
    `cua_driver-0.30.4-py3-none-manylinux_2_31_x86_64.whl` with
    `sha256=e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b`, and the aarch64 wheel
    with `9d7c9bb3…3f08` as before.
  - **Checked independently.** I downloaded the wheel from its PyPI URL
    (`https://files.pythonhosted.org/packages/72/6f/35d12b31be023205f8e1349aab70dd514007d6ccfc9641f21c6c18761236/cua_driver-0.30.4-py3-none-manylinux_2_31_x86_64.whl`)
    to the scratchpad. `shasum -a 256` printed `e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b`.
  - **The amd64 closure is also one wheel.** The wheel's METADATA has only
    `Requires-Dist: pytest; extra == 'test'`. It also ships `cua_driver/bin/cua-driver`, so the
    Dockerfile's `find` works on amd64.
- **The comment part of ruling 2: no line added.** Neither file holds generation instructions for
  the pins:
  - The Dockerfile's comments are the syntax line, the base-digest "resolve with" note, the Cua
    Driver description and the Selkies note. The Cua Driver description ("from
    cua-requirements.txt, where every wheel of its dependency closure is pinned by sha256") stays
    accurate as written.
  - `build.sh` has one comment, "Builds … for the host architecture".

  So, per "don't add a comment where none exists", I added nothing to either file.
- **One edit beyond the ruling: the pins file's header.** It said "for linux/arm64", which would
  misdescribe the file once it carries the amd64 hash. I changed it to "for linux/arm64 and
  linux/amd64". This edits an existing comment and adds none. Veto it if you'd rather keep the
  generated text.

### Commands and output

- **Rebuild.** `BUILDKIT_PROGRESS=plain cells/desktop/build.sh` gave `build exit=0`. The variable
  only makes the log plain text.
  ```
  #2 resolve image config for docker-image://docker.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
  #3 docker-image://docker.io/docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
  #3 CACHED
  #8 CACHED   (apt)
  #9 CACHED   (Node)
  #10 CACHED  (VSCodium)
  #11 [base 5/6] COPY cua-requirements.txt /opt/cua/requirements.txt  DONE 0.0s
  #12 1.372 Collecting cua-driver==0.30.4 (from -r /opt/cua/requirements.txt (line 2))
  #12 1.403   Downloading cua_driver-0.30.4-py3-none-manylinux_2_31_aarch64.whl (32.6 MB)
  #12 2.066 Successfully installed cua-driver-0.30.4
  #13 exporting manifest sha256:5ff0c65f9332349e0b04a71955041ea96e36dbc34b0bcf7c8a4f560b71d7fa90 done
  #13 exporting config sha256:95cfe50798af26518177749383602feead718ff374a27b04b05f1e78155af948 done
  #13 naming to docker.io/localdot/desktop:dev done
  ```
- **Image test.** `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
  gave `Test Files 1 passed (1)`, `Tests 5 passed (5)`. It passed again against the final tag after
  the tamper re-run:
  ```
   ✓ … ships the app set 1063ms
   ✓ … ships Node 24.21.0 115ms
   ✓ … runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off 108ms
   ✓ … has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji 62ms
   ✓ … has the X, accessibility and certificate tools 236ms
   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```
- **`pnpm format && pnpm lint`:** `Formatted 59 files … No fixes applied.` and `Checked 59 files …
  No fixes applied.`
- **Other checks:**
  - `pnpm hygiene`: exit 0.
  - `pnpm typecheck`: all Done.
  - `pnpm test`: 16 files and 145 tests passed.

### Extra verification (not asked for, cheap)

- **The amd64 binding, using the image's own pip and its baked `/opt/cua/requirements.txt`.** I
  ran this in a throwaway `localdot-test-desktop-amd64pins` container, removed with `-fv`:
  ```
  pip download --only-binary=:all: --platform manylinux_2_31_x86_64 --require-hashes -r /opt/cua/requirements.txt
    Downloading cua_driver-0.30.4-py3-none-manylinux_2_31_x86_64.whl (32.2 MB)
    Saved /tmp/amd64/cua_driver-0.30.4-py3-none-manylinux_2_31_x86_64.whl
    Successfully downloaded cua-driver            exit=0
  same command with the old arm64-only line:
    ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE. …
        Expected sha256 9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08
             Got        e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b   exit=1
  ```
  This reproduces concern 1 on the old line and shows it fixed on the new one.
- **Tamper re-run with the brief's exact `sed`, now with two hashes.** It zeroed only the first
  (arm64) hash:
  ```
  cua-driver==0.30.4 --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000 --hash=sha256:e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b
  refused, as it should be
  #12 1.787 ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE. …
  #12 1.787         Expected sha256 0000000000000000000000000000000000000000000000000000000000000000
  #12 1.787         Expected     or e8cdf891b8299d5515e087167df1a628fb9104edd1fba053eaf620f5ddee864b
  #12 1.787              Got        9d7c9bb3eb6df2b52a93f711aa375bdf2c7fbc02fa925f15599b2986e7183f08
  restored build exit=0   (#10, #11, #12 CACHED; naming to docker.io/localdot/desktop:dev done)
  ```
  The x86_64 hash does not loosen the arm64 check. `cmp` confirmed that the restored file is
  identical to the committed one.
- **The image after the restore** is `localdot/desktop:dev`, ID `4fabab4f9586`. Its platform
  manifest `5ff0c65f…` and config `95cfe507…` equal the fix build's, and only the provenance
  attestation differs, as before.

### Docker hygiene after the fix runs

- `docker ps -a --filter name=localdot-test`: header only.
- `docker ps -a --filter name=localdot-cua-pins`: header only.
- `docker network ls --filter name=localdot-test`: header only.
- `docker volume ls --filter dangling=true`: 23 volumes, the same names as the pre-task snapshot,
  none new and none gone.
- `docker image ls --filter dangling=true`: empty.

## Fix report: task review round 1 (the pandoc probe could never fail)

**Status: DONE.** Commit:
`c88b8a4 test(desktop): require every image probe to exit 0 and anchor the pandoc check`. It is a
new commit on top of `3bc926e`, with no amend and no attribution. Only the test file changed:
`docker-cli.ts` and the Dockerfile are untouched.

### The finding, confirmed

- **Why it could never fail.** `dockerExec` returns stdout and stderr joined. Docker's error for a
  missing binary is `exec: "pandoc": executable file not found in $PATH`, which contains `pandoc`.
- **Proof.** The `af56e5a` test, run against an image that is the real one minus pandoc, passed
  5 of 5 (output below).
- **Why my earlier RED missed it.** On the bare base, "ships the app set" stops at its first
  failing probe, libreoffice, so the pandoc probe was never reached.

### The change (`apps/daemon/src/cells/desktop-image.docker.test.ts`)

- **Two test-local helpers.** `outputOf(...cmd)` and `outputAs(user, ...cmd)` call
  `dockerExec`/`dockerExecAs`, assert `status` is 0, and return `out`.
  - On failure the message names the command and carries its output, for example
    `pandoc --version: OCI runtime exec failed: …: expected 127 to be +0`.
  - One two-line comment says why: `out` joins stderr, and Docker's error names the missing binary.
- **Every probe that reads output goes through them, and its content check is unchanged.** There
  are 11 such probes:
  - libreoffice
  - codium (as `abc`)
  - gimp
  - ffmpeg
  - convert
  - pandoc
  - chromium-browser
  - node
  - readlink
  - cua-driver (as `abc`)
  - fc-list
- **Pandoc's check** is now `toMatch(/^pandoc \d/m)`.
- **Probes that already asserted `.status` stay as they were:** the `command -v` loop, xinput,
  `import Xlib`, xprop/certutil and at-spi-bus-launcher.
- **The remaining call needs no assertion.** The one `docker(...)` call, `image inspect`, throws
  on a non-zero exit through `execFileSync`.

`grep -nE 'dockerExec(As)?\('` now lists only the two helpers and the calls that assert `.status`.

### RED: the pandoc probe now has teeth

**The test image.** The bare base can't isolate pandoc, so I built the real image minus pandoc and
tagged it temporarily as `localdot/desktop:dev`:
```
docker tag localdot/desktop:dev localdot-test-desktop-keep      # keep the real image (sha256:4fabab4f…) referenced
printf '%s\n' 'FROM localdot/desktop:dev' 'RUN rm "$(command -v pandoc)" && ! command -v pandoc' \
  | docker build -q -t localdot-test-nopandoc -                  # -> sha256:7352eb7d6d11…
docker tag localdot-test-nopandoc localdot/desktop:dev
```

**The new test fails only at the pandoc probe.** Command:
`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts --reporter=verbose`
```
 × … > ships the app set 559ms
   → pandoc --version: OCI runtime exec failed: exec failed: unable to start container process: exec: "pandoc": executable file not found in $PATH
: expected 127 to be +0 // Object.is equality
 ✓ … > ships Node 24.21.0 131ms
 ✓ … > runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off 126ms
 ✓ … > has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji 61ms
 ✓ … > has the X, accessibility and certificate tools 275ms
 ❯ outputOf apps/daemon/src/cells/desktop-image.docker.test.ts:18:50
 ❯ apps/daemon/src/cells/desktop-image.docker.test.ts:45:12      (line 45 is the pandoc probe)
      Tests  1 failed | 4 passed (5)
```
libreoffice, codium, gimp, ffmpeg and convert passed before it, so the failure is pandoc's alone.

**The old test, on the same image, passes vacuously.** I ran a temporary copy of the `af56e5a`
file and deleted it right after:
```
31:    expect(dockerExec(C, "pandoc", "--version").out).toContain("pandoc");
 ✓ … > ships the app set 1110ms
 ✓ … (all 5)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**The regex alone, a node check on the two texts:**
```
old check on the Docker error: true
new regex on the Docker error: false
new regex on real output:      true
```

**Cleanup.** I ran `docker tag localdot-test-desktop-keep localdot/desktop:dev` and
`docker rmi localdot-test-desktop-keep localdot-test-nopandoc`. Output:
```
Untagged: localdot-test-desktop-keep:latest
Untagged: localdot-test-nopandoc:latest
Deleted: sha256:7352eb7d6d1107c5d6b01ea17cf9add55d623ff6644db86bb8655c757983b28d
restored: sha256:4fabab4f95867e9e747c624af03d8b9f284ceb3b65ba588d9bdf45798c128bf5
matches the recorded real image ID
```

### GREEN

Against the real image (`localdot/desktop:dev`, `4fabab4f9586`), with the same command:
```
 ✓ … > ships the app set 1069ms
 ✓ … > ships Node 24.21.0 121ms
 ✓ … > runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off 115ms
 ✓ … > has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji 72ms
 ✓ … > has the X, accessibility and certificate tools 240ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```
Other checks:
- `pnpm format`: "No fixes applied".
- `pnpm lint`: "Checked 59 files … No fixes applied."
- `pnpm typecheck`: daemon Done.
- `pnpm hygiene`: exit 0.
- `pnpm test`: 16 files and 145 tests passed.

### Docker hygiene after round 1

- `docker ps -a --filter name=localdot-test`: header only.
- `docker ps -a --filter name=localdot-cua-pins`: header only.
- `docker network ls --filter name=localdot-test`: header only.
- `docker volume ls --filter dangling=true`: 23 volumes, the same names as the pre-task snapshot,
  none new and none gone.
- Dangling images: 0.
- `localdot-test-*` images: 0.
- `localdot/desktop:dev` is back on `4fabab4f9586`.
