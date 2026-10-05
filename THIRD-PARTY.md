# Third-party software

localDot's own source is licensed under its root [LICENSE](LICENSE). These
components retain their respective licenses and notices.

| Component | Version | License | Distribution and notice |
| --- | --- | --- | --- |
| mediabunny | 1.61.0 | MPL-2.0 | Used unmodified by the daemon and web app. Its complete license and exact source locations ship with each web build at `/assets/licenses/mediabunny-1.61.0.txt`. |
| Selkies client | Pinned vendored client | See its notice | [Client notice](apps/web/vendor/selkies/NOTICE.md). |
| Desktop cell software | Pinned cell image | See individual components | [Desktop third-party list](cells/desktop/THIRD-PARTY.md). |

mediabunny's Source Code Form for the exact version used here is available from
[the npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz)
and [upstream tag v1.61.0](https://github.com/Vanilagy/mediabunny/tree/v1.61.0).
The daemon uses the installed package with its `LICENSE`; the web build copies
that license unchanged into the notice above. No patch, fork or vendored
mediabunny files are used. The larger localDot work retains its own MIT license.
