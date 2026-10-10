# Install localDot

Run the installer, follow its setup prompts, then open the sign-in link.
The current installer builds from source. Allow **10–30 minutes or longer** for the first
computer-image build. Peak disk requirements have not yet been validated; both your installation
disk and Docker's data disk need free space. Prebuilt distribution is not enabled yet.

## Install

### 1. Run the installer

**macOS or Linux** — open Terminal and run as your normal user, without `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh | bash
```

**Windows** — open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1 | iex
```

Keep PowerShell open. Ubuntu account setup opens in a separate window; create your Linux user
and password there. The installer closes its setup window when the account is ready and continues
automatically in PowerShell. You do not need to type `exit`. If Windows asks for a restart, restart
and sign in again; setup reopens automatically.

In Docker Desktop, enable **Settings → Resources → WSL integration** for Ubuntu (or your chosen
distro), then click **Apply**. The Windows installer waits for Docker and continues automatically
when it is ready. If the WSL integration option is missing, switch Docker Desktop to Linux containers.
If an older installer already stopped, enable integration and rerun it; Ubuntu stays installed.

### 2. Finish prerequisite setup

The installer reuses a working Docker Engine **28+**. If prerequisites are missing, it offers
one setup choice before installing them:

| Platform | Automatic setup | Your part |
| --- | --- | --- |
| Windows | WSL 2, Ubuntu, Linux tools, verified Docker Desktop installer, restart continuation | Approve Windows prompts, create your Ubuntu user, finish Docker's first-run setup, enable WSL integration |
| macOS | Launch Apple's tools installer if needed; download, verify and install Docker Desktop | Finish Apple's prompts, approve administrator access and complete Docker's first-run setup |
| Native Ubuntu/Debian | Build tools and Docker Engine from Docker's signed APT repository | Approve `sudo`; sign out of all sessions or restart once after receiving Docker access, then rerun setup |
| Other Linux distributions | Check prerequisites and give installation instructions | Install [Docker Engine](https://docs.docker.com/engine/install/) 28+, Git, curl, tar and gzip using your distribution's instructions |

Docker Desktop's terms are presented by Docker itself; localDot does not accept them for you.
Existing engines and container data are preserved. An old or conflicting installation is
reported with a repair path, rather than replaced automatically. Downloads can be retried by
rerunning setup. Windows saves its restart continuation under `%LOCALAPPDATA%\localDot\setup`
and removes the sign-in continuation after successful installation. It never restarts Windows itself.

For native Linux, Docker access grants administrator-equivalent control. A new login is needed
for both your shell and background services to receive the new group membership. WSL uses Docker
Desktop integration instead; the Windows installer does not install a second Docker Engine inside Ubuntu.

For unattended prerequisite installation, download the installer and pass
`bash install.sh --install-prerequisites` or `./install.ps1 -InstallPrerequisites`.
This skips localDot's setup question; operating-system authentication, account creation and license
prompts still require you. Without a terminal, the shell installer only checks prerequisites unless
that flag is supplied. To manage dependencies yourself, use `--no-prerequisites` / `-NoPrerequisites`.
You can always [install Docker manually](https://docs.docker.com/engine/install/).

[Lighter runtime alternatives and compatibility requirements](container-runtimes.md).

### 3. Open localDot

Open the sign-in link printed at the end; the installer also tries to open your browser.
On Windows, the installation result and link stay in the original PowerShell window.
Choose a model, add your provider key or supported plan sign-in, then turn on dot’s computer
and send your first task.

Links work once and expire after a minute. To get a new one, or reopen the app later:

```sh
localdot open
```

**On Windows, run `localdot` commands inside Ubuntu/WSL, not PowerShell.** Open the resulting
link in your Windows browser. If your saved keys are locked, run `localdot unlock`.

## If setup stops

Fix the reported issue and rerun the same installer command; it keeps your settings and data.

| Message or problem | What to do |
| --- | --- |
| PowerShell shows `NativeCommandError` at `wsl.exe` | Rerun the installer to get the fix. If WSL setup still fails, open PowerShell as administrator, run `wsl --install --no-distribution`, restart Windows, then rerun the installer. |
| Docker is unavailable | Start Docker. On Windows, enable WSL integration for your distro. |
| `docker-storage-read-only` or `read-only file system` | Docker could not write its storage. Check the host disk holding Docker's data, restart Docker, then rerun setup. If it persists, collect Docker diagnostics. Do not factory-reset Docker or delete its disk image. |
| `docker-storage-full` or `no space left on device` | Check space on both the host disk and Docker's virtual disk. Free space without deleting localDot's computer data, then rerun setup. |
| Final installation checks failed | Setup is not complete. Run `localdot doctor`, fix the reported checks, and rerun the installer. A running web server alone is not a successful installation. |
| `go: command not found` while building the gate image | Rerun the latest installer. It supplies Go automatically; no separate Go installation is needed. |
| A prerequisite is missing | Follow the commands the installer prints, then rerun it. |
| `localdot: command not found` | Open a new terminal. On Windows, use Ubuntu/WSL. If needed, run `~/.local/bin/localdot open`. |
| Sign-in link expired | Run `localdot open` for a fresh link. |
| Saved keys are locked | Run `localdot unlock`. |
| Something else failed | Run `localdot doctor`; use `localdot logs --follow` for details. |

For your phone or a remote server, see [remote access](#servers-without-a-screen).

## What you need

- **macOS** on Apple silicon or Intel, with Docker Desktop.
- **Linux** on x86-64 or ARM64 with glibc and systemd (Ubuntu, Debian, Fedora and similar), with
  Docker Engine 28 or newer.
- **Windows**, through WSL 2: use a Windows version supported by
  [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), with WSL
  integration turned on for your distro. Alternatively, Docker Engine can run inside WSL 2;
  the bootstrap requires Windows 10 build 19041 or newer.
- git, curl, tar and gzip (inside Ubuntu/WSL on Windows). The installer brings its own Node.js and Go,
  checked against pinned checksums,
  and kept in localDot’s own directory. Prerequisite setup can install system packages.
- Free space for downloads, extraction and computer images. Peak usage is not yet validated;
  Docker's virtual disk and its underlying host disk are separate constraints.

Run the localDot installer as your own user, not as root. Installing system prerequisites may
require administrator access or `sudo`; Windows may request elevation for WSL setup.
The installers prepare supported prerequisites before downloading the app and explain anything
that needs your attention. The Windows wrapper waits for Docker integration to become ready.

## Saved keys and logins

Your provider keys are kept by the key service, and the computers only ever see stand-ins.
Saved browser accounts and passwords use the same protected store through a separate private
input channel; they are bound to the exact HTTPS site and never supplied to the model:

- **Linux with a desktop keyring** (GNOME Keyring, KWallet): in the keyring.
- **Linux without one**, such as a server or WSL 2: in an encrypted file. With systemd 256 or
  newer, systemd-creds protects its key and nothing else is needed. Otherwise you choose a
  passphrase.
- **macOS**: in an encrypted file with a passphrase. The Keychain needs the signed release.

On Linux, the keyring and systemd-creds keep saved keys safe from other users of the machine and
from the computers, but not from programs running as you: any of them can read the keyring
(`secret-tool`) or have systemd-creds open the file's key. A **passphrase vault** is the stronger
choice: its file opens only with your passphrase, so no program running as you can read your keys
from the disk or while they're locked. It can't keep them from such a program once you unlock
them: that program could have swapped the `localdot` command or the key service for its own to
catch your passphrase, and on some Linux systems it can read the unlocked key service's memory.
Install with `--passphrase-vault` (or run `localdot update --passphrase-vault`) to use one. It
starts empty, so add your keys again afterwards.

When a passphrase protects your keys, run `localdot unlock` after the computer restarts, or after
an upgrade that changed the key service. The installer asks for it when you run it in a terminal.
Until then the app says the keys are locked and keeps them unused.

The first passphrase the key service receives becomes the vault's. If `localdot unlock` says your
keys already have a passphrase you didn't set, start over: `localdot down`, delete
`~/.localdot/keyd/vault.json` (or `vault-passphrase.json` for a passphrase vault) and
`~/.localdot/passphrase-chosen`, `localdot up`, run `localdot unlock` to choose your own
passphrase, then add your keys again.

## Automatic updates

Settings → Your computer → Software update shows the installed build, last successful check,
new version, download progress, and errors with retry. A quiet notice appears once per version
when dot is idle; dismissing it does not remove the update from Settings.

The installed daemon checks after a short startup delay, then about every six hours with jitter.
Offline failures back off from five minutes to six hours. Checks are shared across tabs and phones,
and preferences and pending updates survive app restarts. Check now bypasses the scheduled delay.
Automatic checks and downloads can each be disabled. Neither shuts down a running computer.

For the current source installer, checks follow your configured Git branch over HTTPS. An exact
commit or tag stays pinned. Download adds Git objects without modifying the running checkout.
Install update asks before shutting down the computer and rebuilding the downloaded commit;
it preserves the branch for future checks. Linux/WSL installation runs in a separate systemd user
service so stopping the daemon cannot kill the installer. This source path is not a signed binary
release. A build can still require dependency/image downloads and take several minutes.
Existing installations need one `localdot update` to register the updater with their service.

The separate packaged-release path verifies publisher provenance, helper signatures and image
digests before marking a download ready. Its Install at next launch option applies a prepared
release only after services have stopped; opening another tab or an idle conversation is not a
restart. Failed activation uses the existing rollback transaction and does not repeat each launch.
Packaged publication/signing/installed acceptance gates remain in [release packaging](release-packaging.md).

## Upgrade, change settings, uninstall

- `localdot update` gets the latest version of the branch you installed and restarts only what
  changed; an unchanged key service keeps running, so it stays unlocked. Running the installer
  again does the same. Your settings are kept; options change them, for example
  `localdot update --ref v0.2.0` or `localdot update --tailscale`.
- `localdot uninstall` (or `install.sh --uninstall`) removes the services, the `localdot`
  command and what the installer put in `~/.local/share/localdot`. It keeps your data and Docker's
  computers and images, and prints the commands that delete them. `--prefix` must name a new or
  empty folder, so uninstalling never removes anything else.

## The localdot command

| Command | What it does |
| --- | --- |
| `localdot up` | Start localDot and print a sign-in link |
| `localdot down` | Stop localDot until you start it again or restart the computer |
| `localdot restart` | Restart localDot |
| `localdot open [--qr]` | Print a fresh, single-use sign-in link; `--qr` also draws it for your phone |
| `localdot doctor` | Check Docker, the images, the key service and the app |
| `localdot unlock` | Enter the passphrase that protects your saved keys |
| `localdot logs [--follow]` | Show recent logs |
| `localdot stop [--all]` | Stop dot's actions (`--all`: every task and computer) |
| `localdot update` | Upgrade and keep your data |
| `localdot uninstall` | Remove localDot and keep your data |

The command lives in `~/.local/bin`. If your shell doesn't find it, open a new terminal or add
that folder to your `PATH`.

## Servers without a screen

localDot only listens on `127.0.0.1`; it is never reachable from your network directly. A
sign-in link works once and expires after a minute. Use either of these methods today.

### SSH tunnel

From your own computer:

```sh
ssh -N -L 4750:127.0.0.1:4750 you@your-server
```

Keep the same port on both ends: localDot only answers to its own address. Then run
`localdot open` on the server and open the link on your computer within a minute.

### Tailscale, for all your devices

Tailscale Serve gives the server an HTTPS address that only devices in your own tailnet can
reach, phones included.

1. Install Tailscale on the server and your devices, and sign in.
2. In the Tailscale admin console under DNS, turn on MagicDNS and HTTPS Certificates.
3. On Linux, let your user change Tailscale's settings once: `sudo tailscale set --operator=$USER`.
4. Run the installer with `--tailscale`, or `localdot update --tailscale`.

The installer runs `tailscale serve --bg --https=4750 http://127.0.0.1:4750` and tells localDot to
accept the server's tailnet name. It never uses Funnel, which would publish localDot on the
internet; don't turn on Funnel for this port. On the server, `localdot open --qr` prints the link
and draws it as a QR code: scan it with your phone within a minute. `--no-tailscale` stops
serving.

### Optional domain relay

The built-in relay is implemented but **public access is awaiting DNS setup and verification**. It is not needed for local,
SSH or Tailscale access. Once a service is configured, enable **Settings → Your computer →
Remote access**, then choose **Copy sign-in link** and open it on your other device within a minute.

It stays off until you enable it. Traffic passes through localDot’s relay and Cloudflare, which
can process it; the Settings panel includes privacy details. Turning it off disconnects remote
devices and revokes access. [Deployment and cost details](remote-access.md).

### Preparing a fresh server

On a new Ubuntu or Debian server, as an administrator:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo adduser dot
sudo usermod -aG docker dot
sudo loginctl enable-linger dot
```

Then sign in as `dot` over SSH (not with `su`, which starts no user session) and run the
installer.

## Advanced installation

### Installer options

To pass options to the shell installer, use `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh | bash -s -- --tailscale
```

For an existing installation, use `localdot update --tailscale`. `localdot update --help`
lists the installer options.

Windows PowerShell accepts `-Distro`, `-Ref`, `-Tailscale` and `-Uninstall`. For example:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1))) -Tailscale
```

The Windows installer enables systemd in the selected distro and adds a hidden Windows task to
keep it running after you sign in.

### What the installer does

1. Gets localDot's source into `~/.local/share/localdot/app` (`--ref` picks a branch, tag or
   commit) and continues with the installer from that version.
2. Gets Node.js and Go into `~/.local/share/localdot/runtime`, builds the app and the key service.
3. Builds the computer images. The first build takes 10 to 30 minutes; later ones reuse Docker's
   cache. `--registry <registry/owner>` pulls images published for the exact version instead, and
   builds any that are missing. Use only a registry you trust: its images run as published,
   without a check against the source.
4. Starts two services:
   - macOS: LaunchAgents `dev.localdot.keyd` and `dev.localdot.daemon`.
   - Linux and WSL 2: systemd user units `localdot-keyd.service` and `localdot-daemon.service`.
     The installer tries to enable lingering so they also run without a login session.
     If permission is needed, it prints the command to run.
5. Runs `localdot doctor` and prints the sign-in link. On a computer with a screen it opens the
   link in your browser.

Your data lives in `~/.localdot` (`--home` chooses another folder), with the logs in
`~/.localdot/logs`. The installer refuses to replace services it did not create, such as an
existing localDot run by hand, and a port something else uses (`--port` chooses another).

### How the computers reach localDot

A computer reaches the internet and your model providers only through localDot's key service. On
Docker Desktop it gets there through `host.docker.internal`. Docker Engine has no such name, and
its containers can't reach services that listen on `127.0.0.1`, so there each computer's gate
gets the key service's socket through a read-only folder, `~/.localdot/keyd/relay`, instead.
`localdot doctor` checks this with a test computer (`gate-relay`). Docker from the Snap Store
can't share that hidden folder: install Docker Engine from docs.docker.com instead.
