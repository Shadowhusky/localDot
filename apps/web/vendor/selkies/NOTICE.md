# Selkies web client (vendored)

These files are the `selkies-dashboard` build shipped in
`lscr.io/linuxserver/webtop@sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804`
(Selkies 2.0.0, per its startup log), extracted with `cells/desktop/scripts/extract-selkies-client.sh`.
The `<link rel="manifest" href="manifest.json">` element was removed from `index.html`,
because the cell generates its own installable manifest at runtime. The core bundle also fetches
that filename for its document title. localDot supplies a static `manifest.json` containing only
its display name, without an install URL or any cell-provided metadata. The extraction script
recreates this local metadata file.

Selkies is licensed under the Mozilla Public License 2.0; `LICENSE` next to this file is that
license's text. Its source is https://github.com/selkies-project/selkies at tag `2.0.0`
(`addons/selkies-dashboard` and `addons/selkies-web-core`), the `SELKIES_RELEASE` that linuxserver's
`docker-baseimage-selkies` Dockerfile pins for the build `53afe260-ls3` (2026-09-29) packaged in this
image. localDot serves these files itself so that
no code loaded into localDot's origin ever comes from a cell. Re-extract them whenever the base
image digest changes.
