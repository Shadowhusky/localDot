# Chromium namespace sandbox profile

`apps/daemon/src/cells/browser-seccomp.json` derives from Moby profiles commit
`6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`, `seccomp/default.json`.
The upstream file's SHA256 is
`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.
Its Apache-2.0 license is retained as `browser-seccomp.LICENSE` beside the profile.

localDot adds restricted clone/unshare allowances for Chromium's user, PID and network
namespaces, plus chroot for its namespace sandbox. Mount, UTS, IPC and cgroup namespace creation
remain denied without capabilities. The container drops all capabilities and enables
no-new-privileges. The runtime launches the real Chromium binary directly; it never uses the
distribution wrapper that disables Chromium's sandbox under seccomp.

The profile previously passed real Chromium startup and renderer inspection in the isolated
Linux runtime probe. Browser provisioning still requires FULL security review and integrated
network, profile-persistence and lifecycle acceptance before release. The daemon's installed
package must retain this fixed asset alongside `browser-spec.ts` (or bundle its bytes).
