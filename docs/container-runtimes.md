# Container runtime choice

localDot currently supports **Docker Engine 28+**, usually through Docker Desktop on macOS and
Windows and the native engine on Linux. The installer reuses an available engine. It does not
switch contexts, replace an existing runtime, or migrate container data.

A lighter runtime is worth exploring, especially on macOS, but “Docker compatible” alone is
not sufficient. localDot calls the Engine API directly and checks an internal bridge network's
`isolated` gateway mode, absence of a gateway, and disabled IPv6. Its containers also depend on
network attachment, exec streaming, volumes, capability restrictions and seccomp.
See [the network checks](../apps/daemon/src/doctor-network.ts) and
[Docker's network documentation](https://docs.docker.com/engine/network/drivers/bridge/).

## Options

| Runtime | Where it fits | Assessment for localDot |
| --- | --- | --- |
| Docker Desktop | Guided setup on macOS and Windows | Supported default. Official installers and WSL integration; some first-run choices remain with the user. |
| OrbStack | macOS | Most promising desktop alternative to evaluate: it runs an unmodified Docker Engine. Its speed and resource claims are vendor claims, not localDot measurements. Free for personal use; commercial use has separate terms. |
| Colima | macOS/Linux with a Docker runtime | Open-source alternative using Lima. A good candidate for users comfortable managing a VM, but adds setup decisions for general users. |
| Rancher Desktop with Moby | macOS, Windows, Linux | Provides Docker API compatibility through Moby. Its containerd mode is a different interface; Kubernetes is unnecessary for localDot. Needs localDot lifecycle and isolation testing. |
| Docker Engine inside WSL | Windows | Avoids the Desktop app, but introduces Linux service startup, user permissions and integration work. Must not be installed alongside Desktop's WSL integration automatically. |
| Apple `container` | Apple silicon Macs on macOS 26 | Modern per-container VM approach with OCI images and an XPC management API. Would require a separate localDot backend and networking review; it is not an installer-only replacement for our Docker API calls. |
| Podman | Linux and VM-backed desktops | Has a Docker compatibility API, but is not a verified substitute for localDot's Docker 28 network semantics. Requires a dedicated adapter/compatibility assessment. |

Sources: [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/),
[Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/),
[Docker Engine for Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
[OrbStack architecture](https://docs.orbstack.dev/faq), [OrbStack terms](https://orbstack.dev/pricing),
[Colima documentation](https://www.colima.run/docs/),
[Rancher Desktop engine choices](https://docs.rancherdesktop.io/ui/preferences/container-engine/general/),
[Docker and WSL](https://docs.docker.com/desktop/features/wsl/),
[Apple container architecture](https://github.com/apple/container/blob/main/docs/technical-overview.md),
[Apple container requirements](https://github.com/apple/container/blob/main/README.md),
[Podman's service API](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html).

## Recommendation

Automate the supported Docker installation now; evaluate OrbStack and Colima as optional Mac
choices before changing the default. No comparative performance numbers have been measured here.
“Newer” does not establish better isolation or reliability.

An alternative should pass the existing network isolation checks and a fresh-install exercise,
then demonstrate browser streaming, command execution, persistent files and browser profiles,
stop/new-conversation behavior, suspend/resume, recovery and app updates. Compare startup time,
idle memory/CPU and task performance on the same machine and images. Never trade the no-gateway
network boundary for a smaller runtime footprint.
