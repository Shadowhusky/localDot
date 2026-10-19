# Startup and Docker readiness

Start at login means the signed-in user's launch service, not a service before macOS login or FileVault unlock. Docker Desktop is a separate prerequisite. [Apple launch agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and [Docker's login setting](https://docs.docker.com/desktop/settings-and-maintenance/settings/) describe these separate lifecycles.

localDot waits for a bounded Docker `/info` response before running computer recovery. While waiting, it serves the app and reports the runtime as unavailable. It does not rewrite computer state because a socket is missing. When the selected engine answers, recovery runs once. Failed recovery stays visible; it is not repeatedly restarted.

With Start at login enabled, the macOS startup path requests Docker Desktop in the background once if its selected local Desktop socket is unavailable. It does not change Docker settings, choose a different engine, request privileges, or alter VM disks. The managed installation's `up --from-login` also requests Desktop before its existing bounded wait. Explicit alternate engine paths are not launched as Desktop.

The selected local Docker CLI context remains selected even while its socket is absent. An explicit `DOCKER_HOST` remains authoritative. This avoids binding the daemon permanently to `/var/run/docker.sock` when Docker Desktop's user socket has not appeared yet.

The UI distinguishes Docker unavailable, startup recovery, and computer startup. Missing Docker takes precedence over a stale starting state or a proposed computer replacement. The status check is bounded; the UI polls every five seconds only while waiting/recovering and checks again on foreground entry. A failed HTTP request is not evidence that Docker is stopped. Create, start, and update check the engine before performing their lifecycle mutations.

The development installation supports its two known user-owned LaunchAgents after checking their executable, working directory, and key service home. Its switch reads actual launchd enablement and changes only the next-login disabled state. It does not restart a running task. Installed builds retain their own installer-controlled lifecycle.

Verification covers delayed/missing engines, shutdown during waiting, unavailable creation without a new record, actual source LaunchAgent inspection, source login enablement, and desktop/mobile Chromium/WebKit recovery screens. No host reboot or Docker disk reset is part of verification; a full logout/reboot remains a separate end-to-end check.
