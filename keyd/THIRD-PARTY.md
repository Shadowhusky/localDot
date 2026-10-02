# keyd third-party code

| Module | Version | License | Used for |
|---|---|---|---|
| `github.com/elazarl/goproxy` | v1.9.2 | BSD-3-Clause | the per-cell listener's CONNECT handling |
| `golang.org/x/net` | v0.50.0 | BSD-3-Clause | HTTP/2, through goproxy |
| `golang.org/x/text` | v0.34.0 | BSD-3-Clause | through `golang.org/x/net` |

`internal/egress/sni.go` is adapted from iron-proxy v0.52.0 (`internal/proxy/snipeek.go`,
Apache-2.0); the license is in `third_party/iron-proxy/LICENSE`. keyd's dial-time address check,
its Basic-auth-aware swap and the shape of its audit lines follow iron-proxy's design without its
code.
