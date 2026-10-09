# Third-party software

localDot's own source is licensed under its root [LICENSE](LICENSE). These
components retain their respective licenses and notices.

| Component | Version | License | Distribution and notice |
| --- | --- | --- | --- |
| mediabunny | 1.61.0 | MPL-2.0 | Used unmodified by the daemon and web app. Its complete license and exact source locations ship with each web build at `/assets/licenses/mediabunny-1.61.0.txt`. |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 0.3.282 | Proprietary: © Anthropic PBC, all rights reserved; use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance) | Used unmodified by the daemon to drive the user's own installed Claude Code. Its bundled Claude Code binaries are not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`); only the user's `claude` runs. Its license ships in the package as `LICENSE.md`. |
| Tailwind CSS | 4.3.3 | MIT | Build-time stylesheet generator for the web app. Its license banner ships at the top of each built stylesheet. |
| Base UI (`@base-ui/react`) | 1.8.0 | MIT (Copyright (c) 2019 Material-UI SAS) | Headless components under the web UI kit in `apps/web/src/ui/`. |
| shadcn/ui component source | generator 4.21.0, `base-vega` style | MIT (Copyright (c) 2023 shadcn) | Generated source, adapted by hand into `apps/web/src/ui/`. |
| Lucide icons | 1.31.0 (35 outlines) | ISC (Copyright (c) 2026 Lucide Icons and Contributors); the outlines Lucide derived from Feather are MIT (Copyright (c) 2013-present Cole Bemis) | Path data vendored unmodified in `apps/web/src/ui/icons.ts`. [License and notices](apps/web/vendor/lucide/LICENSE). |
| Selkies client | Pinned vendored client | See its notice | [Client notice](apps/web/vendor/selkies/NOTICE.md). |
| Desktop cell software | Pinned cell image | See individual components | [Desktop third-party list](cells/desktop/THIRD-PARTY.md). |
| X keysym names (xorgproto `keysymdef.h`, `XF86keysym.h`) | 2025.1 | MIT-style (The Open Group, Digital) | The names and values in [`packages/protocol/src/keysyms.ts`](packages/protocol/src/keysyms.ts), which carries the notice. |

mediabunny's Source Code Form for the exact version used here is available from
[the npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz)
and [upstream tag v1.61.0](https://github.com/Vanilagy/mediabunny/tree/v1.61.0).
The daemon uses the installed package with its `LICENSE`; the web build copies
that license unchanged into the notice above. No patch, fork or vendored
mediabunny files are used. The larger localDot work retains its own MIT license.
