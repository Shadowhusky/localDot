# Install localDot

The packaged alpha installs without GitHub credentials or access to the private source repository.
App archives are signed and checked before installation; computer images are pinned by digest.

## 1. Run one command

**macOS (Apple silicon) and Linux (x64)** — Terminal:

```sh
curl -fsSL https://downloads.localdot.dev/install.sh | bash
```

**Windows** — PowerShell:

```powershell
irm https://downloads.localdot.dev/install.ps1 | iex
```

Run this as your normal user. Setup downloads prebuilt files; it does not compile the app or
computer images. Download time depends on your connection. The current alpha supports Apple silicon
Mac and Linux x64, including Windows through WSL 2. Clean native Windows installation has not yet
been verified for this candidate. Intel Mac and Linux ARM64 packages are not published yet.

In a terminal, setup first shows where it will install and asks once; press Enter to keep those
folders. To use another folder or drive, see [Choose where localDot installs](#choose-where-localdot-installs).

Keep PowerShell open. Ubuntu downloads and installs in PowerShell first, so progress and errors
stay visible. Once it is installed, account setup opens in a separate window; create your Linux user
and password there. PowerShell checks readiness in the background and continues when the account
is ready. If Ubuntu already shows a normal `user@computer` prompt but PowerShell still waits,
type `exit` in that Ubuntu window to release setup. If Windows asks for a restart, restart
and sign in again; setup reopens automatically.

Setup labels each stage and keeps download and package-manager progress visible. During
checks that cannot report a percentage, it shows elapsed time and what it is waiting for.
Docker installs without a completion window blocking localDot; its first-run choices still
appear in Docker Desktop.

In Docker Desktop, enable **Settings → Resources → WSL integration** for Ubuntu (or your chosen
distro), then click **Apply**. The Windows installer waits for Docker and continues automatically
when it is ready. If the WSL integration option is missing, switch Docker Desktop to Linux containers.
If an older installer already stopped, enable integration and rerun it; Ubuntu stays installed.
The installer repeats these instructions while it waits and confirms when Ubuntu can use Docker.

## 2. Finish prerequisite setup

The installer reuses a working Docker Engine **28+**. If prerequisites are missing, it offers
one setup choice before installing them:

| Platform | Automatic setup | Your part |
| --- | --- | --- |
| Windows | WSL 2, Ubuntu, Linux tools, verified Docker Desktop installer, restart continuation | Approve Windows prompts, create your Ubuntu user, finish Docker's first-run setup, enable WSL integration |
| macOS | Download, verify and install Docker Desktop | Approve administrator access and complete Docker's first-run setup |
| Native Ubuntu/Debian | Required tools and Docker Engine from Docker's signed APT repository | Approve `sudo`; sign out of all sessions or restart once after receiving Docker access, then rerun setup |
| Other Linux distributions | Check prerequisites and give installation instructions | Install [Docker Engine](https://docs.docker.com/engine/install/) 28+, curl, tar and gzip using your distribution's instructions |

On macOS, setup adds Docker Desktop's bundled tools to its own process and background-service
paths, including the credential helpers used for image downloads. It keeps your selected Docker
CLI, context and credential configuration. If an older installer reports
`docker-credential-desktop: executable file not found`, rerun the command above to get the fixed
installer; you do not need to remove saved Docker credentials or reset Docker.

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

## 3. Open localDot

Open the sign-in link printed at the end; the installer also tries to open your browser.
On Windows, the installation result and link stay in the original PowerShell window.
Choose a model, add your provider key or supported plan sign-in, then turn on dot’s computer
and send your first task.

Links work once and expire after a minute. To get a new one, or reopen the app later:

```sh
localdot open
```

**On Windows, `localdot` works in PowerShell and Ubuntu/WSL after installation.** Open the resulting
link in your Windows browser. If your saved keys are locked, unlock them in the app or run
`localdot unlock`.

## Choose where localDot installs

localDot keeps the app in `~/.local/share/localdot` and your data (settings, saved keys, task
history and logs) in `~/.localdot`. The first time you run the installer in a terminal, it shows
these folders and asks once:

```text
localDot will be installed in:
  App   ~/.local/share/localdot
  Data  ~/.localdot
Press Enter to continue, or type another folder:
```

Press Enter to keep them, or type another folder, such as one on another drive; on a Mac you can
also drag the folder from Finder into Terminal. The app goes in that folder and your data in its
`data` folder, but data you already have in `~/.localdot` stays there. `~` is your home folder,
and a relative path starts in the current folder.

To choose without the question, pass the folders as options, quoting paths that contain spaces:

```sh
curl -fsSL https://downloads.localdot.dev/install.sh | bash -s -- \
  --prefix "/Volumes/Husky's SSD 4T/localDot" --home "/Volumes/Husky's SSD 4T/localDot/data"
```

`--prefix` is the app's folder and `--home` your data's. `--yes` skips the question and uses the
default folders; a run without a terminal never asks.

On Windows, `-Prefix` and `-HomeDir` choose the folders inside Ubuntu:

```powershell
& ([scriptblock]::Create((irm https://downloads.localdot.dev/install.ps1))) -Prefix '~/apps/localdot' -HomeDir '~/localdot data'
```

Keep them inside Linux: a Windows drive such as `D:\` (which Linux sees as `/mnt/d`) normally
can't keep the file permissions localDot needs, and the installer refuses it.

The installer remembers the folders in `~/.config/localdot/install-location` (in
`$XDG_CONFIG_HOME/localdot` if you set that). Running the installer again, `localdot update`,
`localdot uninstall` and `localdot doctor` all use them. Options win over the remembered folders,
which win over the `LOCALDOT_PREFIX` and `LOCALDOT_HOME` environment variables.

Each folder must be one you can write to, on a drive that keeps file permissions (such as APFS,
HFS+ or ext4, but not exFAT or FAT), and can't be `/` or your home folder itself. The app's folder
must be new, empty or an earlier localDot install. Your data folder's path can be at most 87 bytes
on macOS and 60 on Linux, because localDot's services keep sockets in it. The installer checks the
free space on the drives of both folders.

To move localDot, run `localdot uninstall`, which keeps your data, then install again with
`--prefix` set to the new folder and `--home` to your data folder (move that folder first if it
should go too). While localDot is installed, the installer refuses to install a second copy
elsewhere.

## If setup stops

Fix the reported issue and rerun the same installer command; it keeps your settings and data.

| Message or problem | What to do |
| --- | --- |
| Setup says there are no models to choose from | Update with the public installer for automatic first-run model loading. On older builds, choose **Finish later → Settings → Models → Refresh** (or **Try again**), then return to setup. Your saved key is kept. |
| `hairpin-guard` cannot learn the public address | Current setup waits for initial discovery and uses HTTPS if UDP discovery fails. Rerun the public installer to update older versions. If it still fails, check internet access from Ubuntu and any VPN/firewall rules; the final check prints the lookup failure. |
| `irm` or `curl` returns `404` for the old raw GitHub URL | Use the current installer commands above; old download URLs may no longer be available. |
| PowerShell shows `NativeCommandError` at `wsl.exe` | Rerun the installer to get the fix. If WSL setup still fails, open PowerShell as administrator, run `wsl --install --no-distribution`, restart Windows, then rerun the installer. |
| WSL says changes need a reboot | Save your work and restart Windows. The installer saves a continuation and reopens after sign-in, then installs Ubuntu. If setup does not reopen, run the same installer command again. |
| WSL says no distributions are installed | Rerun the public installer above. It downloads Ubuntu before opening account setup. If the download fails, its WSL error stays visible in PowerShell. |
| Stuck at “Keep this PowerShell window open” | Finish Ubuntu’s username/password prompts. If it already shows a normal shell prompt, type `exit` there. If PowerShell still does not continue, press Ctrl+C in PowerShell and rerun the public installer command above; Ubuntu is kept. |
| Docker is unavailable | Start Docker. On Windows, enable WSL integration for your distro. |
| Docker works in the terminal but localDot reports access denied | Linux may still be running background services with old group permissions. Save work in Ubuntu, run `wsl --terminate Ubuntu` in PowerShell, then reopen Ubuntu and rerun setup. On native Linux, sign out of all sessions or restart. Your installed apps and data are kept. |
| `docker-storage-read-only` or `read-only file system` | Docker could not write its storage. Check the host disk holding Docker's data, restart Docker, then rerun setup. If it persists, collect Docker diagnostics. Do not factory-reset Docker or delete its disk image. |
| `docker-storage-full` or `no space left on device` | Check space on both the host disk and Docker's virtual disk. Free space without deleting localDot's computer data, then rerun setup. |
| `next computer-recovery` | A previous task did not shut down cleanly. Run `localdot doctor --fix` to stop localDot’s services and containers, preserve their data, and recheck. New native tasks save process identities, so recovery can confirm their exit without restarting the host. Then choose **Replace computer** to recover saved apps and files. For older tasks without process evidence, follow the confirmation steps below. Do not delete safety records or reset Docker. |
| Final installation checks failed | Setup is not complete. Run `localdot doctor`, fix the reported checks, and rerun the installer. A running web server alone is not a successful installation. |
| `go: command not found` while building the gate image | Rerun the latest installer. It supplies Go automatically; no separate Go installation is needed. |
| A prerequisite is missing | Follow the commands the installer prints, then rerun it. |
| `localDot is already installed in …` | You chose a different install folder. To move localDot, see [Choose where localDot installs](#choose-where-localdot-installs). |
| A folder `doesn't keep file permissions`, or `you can't write to` it | Choose a folder you own on a drive formatted for macOS or Linux, or connect the drive it is on. See [Choose where localDot installs](#choose-where-localdot-installs). |
| `localdot: command not found` | Open a new terminal. On macOS/Linux/WSL, you can also run `~/.local/bin/localdot open`. On Windows, rerun setup if the PowerShell command is missing. |
| Sign-in link expired | Run `localdot open` for a fresh link. |
| Saved keys are locked | Unlock them in the app (Settings → Keys, or the card in the chat), or run `localdot unlock`. |
| Something else failed | Run `localdot doctor`; use `localdot logs --follow` for details. |

For your phone or a remote server, see [remote access](#servers-without-a-screen).

For an older task whose native process is no longer running, first stop localDot and independently
check that the task and its child processes have exited. Then record that confirmation using the
computer ID printed by `doctor`:

```sh
localdot down
localdot recover --cell COMPUTER_ID --confirm-native-exit
localdot up
```

Choose **Replace computer** in the app. This preserves the computer’s saved apps and files.
The confirmation is recorded locally; it does not kill an unknown process or reset Docker.
Recovery refuses the confirmation if a recorded task process is still running. If you cannot
confirm an older task has exited, restarting the host is an alternative when `doctor` has a
matching record of the task’s original system boot.

## What you need

- **macOS** on Apple silicon, with Docker Desktop.
- **Linux** on x86-64 with glibc and systemd (Ubuntu, Debian, Fedora and similar), with
  Docker Engine 28 or newer.
- **Windows**, through WSL 2: use a Windows version supported by
  [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), with WSL
  integration turned on for your distro. Alternatively, Docker Engine can run inside WSL 2;
  the bootstrap requires Windows 10 build 19041 or newer.
- curl, tar and gzip (inside Ubuntu/WSL on Windows). The installer brings its own Node.js,
  checked against a pinned checksum,
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

When a passphrase protects your keys, unlock them after the computer restarts, or after an upgrade
that changed the key service: in the app's Settings → Keys, or with `localdot unlock`. The
installer asks for it when you run it in a terminal. Until then the app says the keys are locked
and keeps them and saved passwords unused; sites already signed in keep working. When a task needs
them, the chat shows an Unlock card, and dot carries on once they open. The link
`<your localDot address>/#settings=keys&tip=unlock` opens Keys at the passphrase field.

The app seals the passphrase in the page to the key service's own key, so localDot's app server
relays only ciphertext and never reads it; dot never sees it. Only the owner's own link can unlock
(a shared link can't), and after five wrong passphrases each further try waits longer, from 30
seconds up to 15 minutes.

The first passphrase the key service receives becomes the vault's, whether from the app or
`localdot unlock`; both note which vault it opens. If `localdot unlock` says your keys already have
a passphrase you didn't set, start over: `localdot down`, delete
`~/.localdot/keyd/vault.json` (or `vault-passphrase.json` for a passphrase vault) and
`~/.localdot/passphrase-chosen`, `localdot up`, run `localdot unlock` to choose your own
passphrase, then add your keys again.

Model lists load automatically from the public models.dev catalog, without an AI call or sending
an API key. Saved lists appear immediately and refresh in the background once five minutes old.
Setup checks again when you change provider; open pages pick up refreshed lists automatically.
If the catalog is unreachable, the saved list stays usable and is marked as older. Your chosen
model stays selected. Catalog entries describe models, not your account’s access or remaining credit.

## Automatic updates

Settings → Your computer → localDot updates shows the installed build, the last successful
check and the new version. While an update downloads, a bar under it says how far it has got
("Downloading · 212 of 640 MB", then "Preparing the computer · 1.4 of 3.1 GB") and never moves
back; then it says "Ready to install". Under the group, "What's new in" shows the new version's
release notes, with any versions it skips folded below. If an update fails, one sentence says so
over the steps it went through, marking the one that failed. Installing shows "Restarting
localDot…" until the new version answers, then the page reloads and says once "Updated to …",
with its notes a tap away. A quiet notice appears once per version when dot is idle; dismissing
it does not remove the update from Settings.

The installed daemon checks after a short startup delay, then about every six hours with jitter.
Offline failures back off from five minutes to six hours. Checks are shared across tabs and phones,
and preferences and pending updates survive app restarts. Check now bypasses the scheduled delay.
Automatic checks and downloads can each be disabled. Neither shuts down a running computer.

For source installations, checks follow your configured Git branch over HTTPS. An exact
commit or tag stays pinned. Download adds Git objects without modifying the running checkout.
Install update asks before shutting down the computer and rebuilding the downloaded commit;
it preserves the branch for future checks. Linux/WSL installation runs in a separate systemd user
service so stopping the daemon cannot kill the installer. This source path is not a signed binary
release. A build can still require dependency/image downloads and take several minutes.
Existing installations need one `localdot update` to register the updater with their service.

The public testing channel checks the signed catalog, archive inventory and image digests.
Download fetches and checks the app package and then the computer's four pinned images, so that
installing only swaps versions and restarts: the installer checks the kept package against the
signed catalog again and skips images Docker already holds. With less than 10 GB free, the images
are left for the installer and Settings says so. An update from 0.1.0-rc.31 or earlier still runs
that version's installer, which downloads everything again.
`localdot update` installs the newest testing package while keeping your settings and computer data.
The separate signed desktop-release path verifies publisher provenance, helper signatures and image
digests before marking a download ready. Its Install at next launch option applies a prepared
release only after services have stopped; opening another tab or an idle conversation is not a
restart. Failed activation uses the existing rollback transaction and does not repeat each launch.
Packaged publication/signing/installed acceptance gates remain in [release packaging](release-packaging.md).

## Several dots on one computer

Each dot has its own data folder, address, saved keys and computer, and one installation runs them
all. Add one from **Settings → Your computer → Add a dot on this computer…**, or in Terminal:

```sh
localdot dots add Work
localdot dots add "Home Mac" --from work --copy settings,keys,conversations
```

Give it a name and choose the dot to copy from. Under **Advanced** (`--copy`), choose what it takes:

| Copied unless you turn it off | Copied only when you turn it on |
| --- | --- |
| Settings: models, autonomy, budgets, persona and accessory | Conversations, which can be large (on a Mac's own disk the copies share space until they change) |
| Keys and saved passwords | dot's computer: its system and home folder. Stop that dot's computer first |
| Memory, skills and connectors | Browser sign-ins. Copied sign-ins can sign each other out |

A dot's own identity and sign-in token, remote access, phone notifications, ChatGPT sign-in and the
key service's audit and spending records are never copied. Claude Code's sign-in lives in your own
`~/.claude`, so every dot shares it. Keys go from one key service straight to the other, which
first checks that it is talking to localDot's own key service; neither the app nor the command
sees them. If your keys use a passphrase, you choose one for the new dot as it is added.

The new dot starts right away with the next free set of ports: the second dot answers at
`http://127.0.0.1:5750`, the third at 6750. Its data folder sits beside the first one's
(`~/.localdot-work`); `--home` chooses another. It starts at login when the first dot does.

- **Switching:** the localDot menu at the top left lists every dot on this computer under **On this
  computer**. Choosing one signs you in there, starting it first if it is stopped; there is no link
  to paste. From Terminal: `localdot open --dot work`.
- **Your phone:** when Tailscale serves the dot it copies from, a new dot is served at its own
  port, such as `https://your-mac.your-tailnet.ts.net:5750`. Remote access through localdot.dev
  stays off for a new dot until you turn it on in its Settings.
- **Computers:** every dot's computer can run at the same time. Each may use up to 4 GB, so before
  another one starts, localDot checks Docker's memory and says when to raise it (Docker Desktop →
  Settings → Resources); **Start anyway** starts it regardless. If Docker later stops a computer
  for memory, its message says the same. Stopping a dot also stops its computers.
- **Updates:** every dot runs the same installation, so an update installs for all of them and
  restarts them together. Settings waits while a dot is working and says which one.
- **Removing:** Settings → Your computer → **Remove this dot**, or `localdot dots remove work`,
  stops the dot and removes its services, saved keys, computers and Tailscale address. Its data
  folder stays unless you tick **Also delete its data** (`--delete-data`). The first dot stays;
  `localdot uninstall` removes every dot's services and keeps every dot's data.

`~/.config/localdot/dots.json` lists the dots; each data folder's `instance.json` holds that dot's
name, ports and key service name. A data folder without one is the first dot, as every installation
from before several dots is. On Windows, every dot runs in the same Ubuntu, which the one localDot
task keeps running.

## Upgrade, change settings, uninstall

- `localdot update` gets the latest version of your package channel (or your branch for a source
  install) and restarts only what changed; an unchanged key service keeps running, so it stays unlocked. Running the installer
  again does the same. Your settings are kept; options change them, for example
  `localdot update --tailscale`. Source-only `--ref` does not apply to packaged installs.
- `localdot uninstall` (or `install.sh --uninstall`) removes the services, the `localdot`
  command and what the installer put in the app's folder (`~/.local/share/localdot` unless you
  [chose another](#choose-where-localdot-installs)). It keeps your data and Docker's computers and
  images, and prints the commands that delete them. `--prefix` must name a new or empty folder, so
  uninstalling never removes anything else.

## The localdot command

| Command | What it does |
| --- | --- |
| `localdot up` | Start localDot and print a sign-in link |
| `localdot down` | Stop localDot services and its computers; keep installed apps, sign-ins and files |
| `localdot start-at-login on` / `off` | Choose whether localDot starts when you sign in; does not interrupt current work |
| `localdot restart` | Restart localDot from any state (stopped, crashed, not answering, a stale lock) and print a sign-in link. Its key service restarts only when it isn't answering. Refuses during an update and names a program holding the port. A running task stops; computers keep running, and data and task history are kept |
| `localdot status [--json]` | Show the app, its services, key service, Docker, computers and their tasks, remote access, Tailscale and updates; exits 1 when localDot isn't answering |
| `localdot open [--qr]` | Print a fresh, single-use sign-in link; `--qr` also draws it for your phone |
| `localdot link [local\|network\|remote] [--qr \| --json]` | Print one-use sign-in links for this computer, your network (Tailscale and other HTTPS addresses) and remote access, each with its own code that expires within a minute; says how to set up any that are missing |
| `localdot remote on` / `off` / `status` | Turn remote access through the localDot relay on or off, or show it |
| `localdot tailscale on` / `status` | Share localDot with your devices on Tailscale (prints the page that allows HTTPS when Tailscale asks), or show its state |
| `localdot computer list` / `start` / `stop` / `restart` / `resume [--cell ID]` | List computers and their tasks, start, stop or restart one (refused while a task runs on it), or resume one that `localdot stop` froze |
| `localdot doctor` | Check Docker, computer container states, task recovery, and the app |
| `localdot recover --cell ID` | Show the confirmation command for an older interrupted native task |
| `localdot doctor --fix` | Stop localDot services and containers, preserve their data, restart the app, and check again. Interrupts running tasks; does not restart Docker. |
| `localdot unlock` | Enter the passphrase that protects your saved keys |
| `localdot logs [--follow]` | Show recent logs |
| `localdot stop [--all]` | Stop dot's actions (`--all`: every task and computer) |
| `localdot update` | Upgrade and keep your data |
| `localdot uninstall` | Remove localDot and keep your data |
| `localdot dots list` | List the dots on this computer, with their addresses and folders |
| `localdot dots add <name> [--from <dot>] [--copy …]` | Add a dot; see [Several dots on one computer](#several-dots-on-one-computer) |
| `localdot dots remove <dot> [--delete-data]` | Remove a dot; its data stays unless `--delete-data` |
| `localdot up`, `down`, `restart`, `status`, `doctor`, `open`, `link`, `remote`, `tailscale`, `computer`, `unlock` or `logs` with `--dot <dot>` | Run the command for that dot |

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

### Copy a sign-in link

In **Settings → Your computer → App links**, copy a fresh link for the local address or a
configured Tailscale/HTTPS address. Links work once and expire after one minute. The local
address works only on the host computer; Tailscale requires both devices on your tailnet.
The optional relay has its own **Copy sign-in link** under Remote access.

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

The optional relay is available at `localdot.dev`. It is not needed for local, SSH or Tailscale
access. Enable **Settings → Your computer → Remote access**, then choose **Copy sign-in link**
and open it on your other device within a minute.

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

For a locally saved installer from an authenticated source checkout:

```sh
bash install.sh --tailscale
```

The source installer also needs authenticated Git access when it downloads the app.

For an existing installation, use `localdot update --tailscale`. `localdot update --help`
lists the installer options.

Windows PowerShell accepts `-Distro`, `-Ref`, `-Prefix`, `-HomeDir`, `-Tailscale` and
`-Uninstall`. For example:

```powershell
./install.ps1 -Tailscale
```

The Windows installer enables systemd in the selected distro and adds a hidden Windows task to
keep it running after you sign in.

### What the source installer does

The public commands at the top download prebuilt packages. The steps below apply only to
an authenticated source checkout, not to the packaged installer.

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

Your data lives in `~/.localdot` unless you [chose another folder](#choose-where-localdot-installs),
with the logs in its `logs` folder. The installer refuses to replace services it did not create, such as an
existing localDot run by hand, and a port something else uses (`--port` chooses another).

### How the computers reach localDot

A computer reaches the internet and your model providers only through localDot's key service. On
Docker Desktop it gets there through `host.docker.internal`. Docker Engine has no such name, and
its containers can't reach services that listen on `127.0.0.1`, so there each computer's gate
gets the key service's socket through a read-only folder, `~/.localdot/keyd/relay`, instead.
`localdot doctor` checks this with a test computer (`gate-relay`). Docker from the Snap Store
can't share that hidden folder: install Docker Engine from docs.docker.com instead.

### Idle use and device links

Hiding the app suspends its screen connection and viewer polling. Returning refreshes the
screen and task status. Tasks and scheduled routines continue while the page is hidden.
Use `localdot down` to stop the services and localDot containers completely; unrelated Docker
apps are left running. Settings → Your computer → Open at login controls future startup.

App links checks the Windows host as well as Ubuntu. An existing Tailscale HTTPS route appears
automatically; if Tailscale is connected without a route, choose **Enable Tailscale link**.
This uses private Tailscale Serve, not public Funnel. LAN addresses are labeled unavailable
when no LAN listener exists, rather than offering a link that cannot connect. WSL localhost
forwarding alone does not expose the app to other devices on the LAN.

Remote access uses localDot’s relay and stays off until enabled. Pairing requires both the
relay cookie and the app sign-in, including history, replay, file and control requests.
