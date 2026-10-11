<#
.SYNOPSIS
Installs localDot on Windows through WSL 2.

.DESCRIPTION
Turns on WSL 2, sets up a Linux distribution with systemd, runs localDot's Linux installer
(install.sh) inside it, and keeps that Linux running after you sign in to Windows. Run it again
to upgrade. See docs/install.md.

.EXAMPLE
irm https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1 | iex

.EXAMPLE
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1))) -Tailscale
#>
[CmdletBinding()]
param(
  [string]$Distro = "Ubuntu",
  [string]$Ref,
  [switch]$Tailscale,
  [switch]$Uninstall,
  [switch]$InstallPrerequisites,
  [switch]$NoPrerequisites,
  [switch]$Resume
)

$ErrorActionPreference = "Stop"
$InstallUrl = "https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh"
$TaskName = "localDot"
$KeepRunning = Join-Path $env:LOCALAPPDATA "localDot\keep-running.vbs"
$InstallerScriptPath = $PSCommandPath
$SetupDirectory = Join-Path $env:LOCALAPPDATA "localDot\setup"
$ResumeKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'

function Save-SetupResume {
  try { Write-SetupResume }
  catch {
    Write-Host "Couldn't save automatic continuation: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "After restarting Windows, run the same localDot installer command again. Completed setup is kept."
  }
}

function Write-SetupResume {
  New-Item -ItemType Directory -Force $SetupDirectory | Out-Null
  $saved = Join-Path $SetupDirectory 'install.ps1'
  if ($InstallerScriptPath) {
    if ([IO.Path]::GetFullPath($InstallerScriptPath) -ne [IO.Path]::GetFullPath($saved)) { Copy-Item $InstallerScriptPath $saved -Force }
  } else {
    Receive-SetupFile 'https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1' $saved
  }
  @{ Distro = $Distro; Ref = $Ref; Tailscale = [bool]$Tailscale; InstallPrerequisites = [bool]$InstallPrerequisites; NoPrerequisites = [bool]$NoPrerequisites; Resume = $true } |
    ConvertTo-Json | Set-Content (Join-Path $SetupDirectory 'options.json') -Encoding UTF8
  $runner = Join-Path $SetupDirectory 'resume.ps1'
  @'
$ErrorActionPreference = 'Stop'
$options = @{}
(Get-Content (Join-Path $PSScriptRoot 'options.json') -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $options[$_.Name] = $_.Value }
try { & (Join-Path $PSScriptRoot 'install.ps1') @options }
catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }
Read-Host 'Press Enter to close this setup window'
'@ | Set-Content $runner -Encoding UTF8
  if (-not (Test-Path $ResumeKey)) { New-Item -Path $ResumeKey | Out-Null }
  New-ItemProperty -Path $ResumeKey -Name 'localDotSetup' -PropertyType String -Force -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`"" | Out-Null
  Write-Host "Setup is saved and will reopen after you restart Windows and sign in."
  Write-Host "To cancel that continuation: Remove-ItemProperty -Path '$ResumeKey' -Name localDotSetup"
}

function Receive-SetupFile([string]$Url, [string]$Path) {
  $previous = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $previous -bor [Net.SecurityProtocolType]::Tls12
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -TimeoutSec 600; return }
      catch { if ($attempt -eq 3) { throw }; Start-Sleep -Seconds 2 }
    }
  } finally { [Net.ServicePointManager]::SecurityProtocol = $previous }
}

function Approve-Prerequisites {
  if ($NoPrerequisites) { return $false }
  if ($InstallPrerequisites) { return $true }
  Write-Host "localDot can install missing Linux build tools and Docker Desktop. Windows may ask for permission."
  Write-Host "Existing Docker installations are kept. Docker's license and first-run choices stay in its own window."
  $answer = Read-Host 'Install missing prerequisites and continue? [Y/n]'
  if ($answer -notin @('', 'y', 'yes')) { return $false }
  $script:InstallPrerequisites = [switch]$true
  return $true
}

function Ensure-LinuxTools {
  $check = Invoke-Wsl -d $Distro --exec sh -c 'for tool in git curl tar gzip timeout; do command -v $tool >/dev/null 2>&1 || exit 1; done'
  if ($check.Code -eq 0) { return }
  if (-not (Approve-Prerequisites)) { throw "Install git, curl, tar, gzip and coreutils inside $Distro, then rerun setup." }
  Write-Host "Installing Linux build tools in $Distro..."
  & wsl.exe -d $Distro -u root --exec sh -c 'command -v apt-get >/dev/null || exit 2; apt-get update && apt-get install -y git curl tar gzip coreutils ca-certificates'
  if ($LASTEXITCODE -ne 0) { throw "Couldn't install build tools in $Distro. Check the package-manager output above." }
}

function Install-DockerDesktop {
  if (-not (Approve-Prerequisites)) { return $false }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $platform = 'amd64'; $digest = 'a9814e31049d66156477a86614e83365669677733014ec72f74229623ff3890a' }
    'ARM64' { $platform = 'arm64'; $digest = '2cfdd5f1a325f0f38c02adda47ff35ab929da328684df5633ea21e522ad79ec5' }
    default { throw "Docker Desktop requires 64-bit Windows (Intel/AMD or ARM)." }
  }
  $folder = Join-Path ([IO.Path]::GetTempPath()) ('localdot-docker-' + [guid]::NewGuid())
  New-Item -ItemType Directory $folder | Out-Null
  $file = Join-Path $folder 'Docker Desktop Installer.exe'
  try {
    Write-Host "Downloading Docker Desktop 4.94.0. This may take a few minutes..."
    Receive-SetupFile "https://desktop.docker.com/win/main/$platform/241994/Docker%20Desktop%20Installer.exe" $file
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $digest) { throw "Docker download verification failed. Nothing was installed; rerun setup to retry." }
    $signature = Get-AuthenticodeSignature $file
    if ($signature.Status -ne 'Valid') { throw "Windows couldn't verify Docker's installer signature. Nothing was installed." }
    # Intentionally omit --accept-license. Docker presents its terms to the user on first run.
    $process = Start-Process -FilePath $file -ArgumentList 'install', '--user', '--backend=wsl-2' -Wait -PassThru
    if ($process.ExitCode -in @(3010, 1641)) { Save-SetupResume; return $false }
    if ($process.ExitCode -ne 0) { throw "Docker setup stopped (exit $($process.ExitCode)). Rerun localDot setup to retry." }
    return $true
  } finally { Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue }
}

# Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords. WSL's expected
# "not installed" response must reach the exit-code check, rather than abort the installer.
function Invoke-Wsl {
  $ErrorActionPreference = "Continue"
  $PSNativeCommandUseErrorActionPreference = $false
  $previousUtf8 = $env:WSL_UTF8
  $previousEncoding = [Console]::OutputEncoding
  try {
    $env:WSL_UTF8 = "1"
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $output = & wsl.exe @args 2>&1
    $code = $LASTEXITCODE
    # ToString keeps stderr text without PowerShell's CategoryInfo/error-location formatting.
    # Older inbox WSL ignores WSL_UTF8; strip NULs so its ASCII distro list remains readable.
    $text = (($output | ForEach-Object { $_.ToString() }) -join "`n") -replace "`0", ""
    [pscustomobject]@{ Code = $code; Text = $text.Trim() }
  } finally {
    [Console]::OutputEncoding = $previousEncoding
    $env:WSL_UTF8 = $previousUtf8
  }
}

function Get-WslDistros {
  # WSL's verbose list fails when empty. Quiet enumeration succeeds with no names,
  # avoiding both a false service error and parsing localized diagnostic text as rows.
  # Include all states so an in-progress registration is not mistaken for absence.
  $names = Invoke-Wsl --list --all --quiet
  if ($names.Code -ne 0) { throw "Could not list WSL distributions (exit $($names.Code)): $($names.Text). Check wsl --status before retrying; no distribution was installed or removed." }
  if ([string]::IsNullOrWhiteSpace(($names.Text -replace '[\uFEFF\uFFFE]', ''))) { return }
  $list = Invoke-Wsl --list --verbose
  if ($list.Code -ne 0) { throw "Could not list WSL distributions (exit $($list.Code)): $($list.Text). Check wsl --status before retrying; no distribution was installed or removed." }
  foreach ($line in ($list.Text -split "`r?`n" | Select-Object -Skip 1)) {
    $fields = @(($line -replace '^\s*\*?\s*', '').Trim() -split '\s+')
    if ($fields.Count -ge 3 -and $fields[-1] -match '^[12]$') { [pscustomobject]@{ Name = $fields[0]; Version = $fields[-1] } }
  }
}

# One line without double quotes, so Windows PowerShell passes it to wsl.exe intact.
$EnableSystemd = "f=/etc/wsl.conf; touch `$f; " +
  "if grep -q '^\[boot\]' `$f; then " +
  "if grep -q '^[[:space:]]*systemd[[:space:]]*=' `$f; then sed -i 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' `$f; " +
  "else sed -i '/^\[boot\]/a systemd=true' `$f; fi; " +
  "else printf '\n[boot]\nsystemd=true\n' >> `$f; fi"

function Get-WindowsBuild { [Environment]::OSVersion.Version.Build }

function Enable-Wsl {
  if ((Get-WindowsBuild) -lt 19041) {
    throw "localDot needs Windows 10 version 2004 (build 19041) or newer for WSL 2."
  }
  if ((Invoke-Wsl --status).Code -ne 0) {
    if ($NoPrerequisites) { throw "WSL 2 is missing. Install it with wsl --install, or rerun setup without -NoPrerequisites." }
    Write-Host "Turning on WSL 2. Windows asks for permission first."
    $install = Start-Process -FilePath "wsl.exe" -ArgumentList "--install", "--no-distribution" -Verb RunAs -Wait -PassThru
    if ($install.ExitCode -notin @(0, 3010)) {
      throw "WSL setup didn't finish (exit $($install.ExitCode)). Open PowerShell as administrator, run 'wsl --install --no-distribution', restart Windows, then run this installer again."
    }
    Save-SetupResume
    Write-Host "Restart Windows to finish turning on WSL."
    return $false
  }
  # systemd needs the WSL from the Microsoft Store; the one built into older Windows lacks --version.
  if ((Invoke-Wsl --version).Code -ne 0) {
    if ($NoPrerequisites) { throw "Update WSL with wsl --update, then rerun setup." }
    Write-Host "Updating WSL."
    $update = Invoke-Wsl --update
    if ($update.Code -ne 0) { throw "Couldn't update WSL. Run 'wsl --update' in PowerShell as administrator, then run this installer again." }
  }
  return $true
}

# WSL may print a startup notice before id's output. Only accept the final nonempty
# line from a successful command, never a number embedded in an error message.
function Get-WslUserId($Result) {
  if ($Result.Code -ne 0) { return $null }
  $lines = @(($Result.Text -replace "`0", '' -replace '[\uFEFF\uFFFE]', '') -split "`r?`n" | Where-Object { $_.Trim() })
  if ($lines.Count -gt 0 -and $lines[-1].Trim() -match '^\d+$') { return $lines[-1].Trim() }
  return $null
}

function Initialize-Distro {
  $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
  if ($found.Count -eq 0) {
    if ($NoPrerequisites) { throw "Install $Distro with wsl --install --distribution $Distro, then rerun setup." }
    if (-not (Install-Distro)) { return $false }
    $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
    if ($found.Count -eq 0) { throw "$Distro isn't set up yet. Open it once from the Start menu to create your user, then run this installer again." }
  }
  if ($found[0].Version -eq "1") {
    if ($NoPrerequisites) { throw "Move $Distro to WSL 2 with wsl --set-version $Distro 2, then rerun setup." }
    Write-Host "Moving $Distro to WSL 2."
    & wsl.exe --set-version $Distro 2
    if ($LASTEXITCODE -ne 0) { throw "Moving $Distro to WSL 2 failed." }
  }
  $user = Invoke-Wsl -d $Distro --exec id -u
  $uidText = Get-WslUserId $user
  if ($null -eq $uidText) {
    throw "Couldn't confirm a Linux user in $Distro (exit $($user.Code)): $($user.Text). Run 'wsl -d $Distro' to check its setup, then rerun this installer."
  }
  if ($uidText -eq "0") {
    throw "$Distro signs in as root. Create your own user in it and make that the default; see docs/install.md."
  }
  if ((Invoke-Wsl -d $Distro --exec test -d /run/systemd/system).Code -ne 0) {
    if ($NoPrerequisites) { throw "Enable systemd in /etc/wsl.conf for $Distro, restart that distro, then rerun setup." }
    Write-Host "Turning on systemd in $Distro."
    $result = Invoke-Wsl -d $Distro -u root --exec sh -c $EnableSystemd
    if ($result.Code -ne 0) { throw "Couldn't turn on systemd in ${Distro}: $($result.Text)" }
    & wsl.exe --terminate $Distro | Out-Null
  }
  return $true
}

# Probe WSL without blocking PowerShell's progress/timeout loop. Async stream reads avoid
# a full stderr pipe deadlocking the child. Only this probe client is killed on timeout.
function Get-SetupTime { [DateTime]::UtcNow }

function Start-SetupProbe([string]$FilePath, [string]$Arguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $info.Arguments = $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $info.EnvironmentVariables['WSL_UTF8'] = '1'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw "Couldn't start the WSL readiness check." }
    [pscustomobject]@{
      Process = $process
      Output = $process.StandardOutput.ReadToEndAsync()
      ErrorOutput = $process.StandardError.ReadToEndAsync()
      Started = Get-SetupTime
    }
  } catch { $process.Dispose(); throw }
}

function Read-SetupProbe($Probe) {
  if (-not $Probe.Process.HasExited -or -not $Probe.Output.IsCompleted -or -not $Probe.ErrorOutput.IsCompleted) { return $null }
  $text = if ($Probe.Process.ExitCode -eq 0) { $Probe.Output.Result } else { $Probe.Output.Result + $Probe.ErrorOutput.Result }
  [pscustomobject]@{ Code = $Probe.Process.ExitCode; Text = ($text -replace "`0", '').Trim() }
}

function Stop-SetupProbe($Probe) {
  try {
    if (-not $Probe.Process.HasExited) {
      $Probe.Process.Kill()
      $null = $Probe.Process.WaitForExit(1000)
    }
  } finally { $Probe.Process.Dispose() }
}

# WSL can print ERROR_SUCCESS_REBOOT_REQUIRED yet return 0 without installing a
# distro (WslClient.cpp, Install). Ask Windows for that exact localized system
# message instead of maintaining English/Chinese substring guesses.
function Get-WslRestartMessage {
  if ($env:OS -ne 'Windows_NT') { return $null }
  return ([ComponentModel.Win32Exception]::new(3010)).Message
}

function Test-WslRestartMessage([string]$Text) {
  $message = Get-WslRestartMessage
  if ([string]::IsNullOrWhiteSpace($message)) { return $false }
  $normalizedMessage = ($message -replace '\s', '').Trim()
  $normalizedText = ($Text -replace "`0", '' -replace '\s', '').Trim()
  return $normalizedText.Contains($normalizedMessage)
}

function Install-Distro {
  if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid distribution name: $Distro" }
  # Complete the download/registration in this console. A separate install window can
  # disappear with the only useful error, leaving us probing a distro that never existed.
  Write-Host "Downloading and installing $Distro. Progress and any WSL errors appear below."
  $installOutput = [System.Collections.Generic.List[string]]::new()
  $previousPreference = $ErrorActionPreference
  $previousEncoding = [Console]::OutputEncoding
  $previousUtf8 = $env:WSL_UTF8
  try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $env:WSL_UTF8 = '1'
    # Windows PowerShell treats native stderr as an error record, even for progress.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    & wsl.exe --install --distribution $Distro --web-download --no-launch 2>&1 | ForEach-Object {
      # Stream progress immediately and retain a bounded tail for the restart notice.
      $installOutput.Add([string]$_)
      if ($installOutput.Count -gt 100) { $installOutput.RemoveAt(0) }
      $_ | Out-Host
    }
    $installCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    [Console]::OutputEncoding = $previousEncoding
    $env:WSL_UTF8 = $previousUtf8
  }
  if ($installCode -in @(3010, 1641) -or ($installCode -eq 0 -and (Test-WslRestartMessage ($installOutput -join "`n")))) {
    Save-SetupResume
    Write-Host "Windows needs a restart before it can install $Distro. Save your work, restart Windows, and sign in again; localDot setup will reopen."
    return $false
  }
  if ($installCode -ne 0) {
    throw "Installing $Distro failed (exit $installCode). The WSL error is printed above. Account setup has not started. Fix that error, then rerun this installer; completed setup is kept."
  }
  # Exit 0 alone is not evidence that Ubuntu exists. Never enter account polling until
  # registration is confirmed, and never list synchronously during interactive first run.
  $registered = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
  if ($registered.Count -eq 0) {
    throw "WSL finished without registering $Distro. Account setup has not started. Run 'wsl --update --web-download', then 'wsl --install --distribution $Distro --web-download' in this PowerShell window and check its output. Rerun localDot setup after $Distro appears in 'wsl --list --verbose'."
  }
  Write-Host "$Distro is installed. Opening its Linux account setup in a separate window."
  Write-Host "Create your Linux user name and password there. Keep this PowerShell window open."
  Write-Host "If Ubuntu reaches a normal user@computer prompt but setup still waits, type exit in that Ubuntu window."
  Write-Host "Press Ctrl+C here to stop waiting; your Ubuntu installation is kept."
  $setup = Start-Process -FilePath "wsl.exe" -ArgumentList "--distribution", $Distro -PassThru
  $probe = $null
  $accountReady = $false
  $closedDeadline = $null
  $lastReadiness = "WSL has not answered the account check."
  $deadline = (Get-SetupTime).AddMinutes(30)
  $nextNotice = (Get-SetupTime).AddSeconds(15)
  try {
    while ((Get-SetupTime) -lt $deadline) {
      $setup.Refresh()
      if ($setup.HasExited -and $setup.ExitCode -in @(3010, 1641)) {
        Save-SetupResume
        Write-Host "Restart Windows to finish setting up $Distro."
        return $false
      }
      if ($setup.HasExited -and $setup.ExitCode -ne 0) {
        throw "$Distro account setup closed with exit $($setup.ExitCode). Run 'wsl -d $Distro' in this PowerShell window to see its error, then rerun this installer."
      }
      if ($setup.HasExited -and $null -eq $closedDeadline) {
        # Successful launcher exit is not proof that registration/account setup failed.
        $closedDeadline = (Get-SetupTime).AddSeconds(60)
        Write-Host "$Distro's setup window has exited. Checking its account for up to one minute..."
        Write-Host "If account setup has not appeared, open $Distro from the Windows Start menu."
      }
      if (-not $probe) {
        # WSL may still be finishing first-run setup; retry transient account errors.
        $probe = Start-SetupProbe 'wsl.exe' "-d $Distro --exec id -u"
      }
      $result = Read-SetupProbe $probe
      if ($null -ne $result) {
        Stop-SetupProbe $probe
        $probe = $null
        $uidText = Get-WslUserId $result
        if ($null -ne $uidText -and $uidText -ne "0") {
          $accountReady = $true
          Write-Host "$Distro account is ready. Continuing localDot installation..."
          return $true
        }
        if ($uidText -eq "0") {
          $lastReadiness = "$Distro still starts as root (uid 0); its default Linux user is not ready."
        } else {
          $detail = $result.Text
          if ([string]::IsNullOrWhiteSpace($detail)) { $detail = 'No user ID was returned.' }
          $lastReadiness = "WSL account check returned exit $($result.Code): $detail"
        }
      } elseif (((Get-SetupTime) - $probe.Started).TotalSeconds -ge 15) {
        Stop-SetupProbe $probe
        $probe = $null
        $lastReadiness = "WSL did not answer the account check within 15 seconds."
        Write-Host "$lastReadiness Retrying."
      }
      if ($null -ne $closedDeadline -and (Get-SetupTime) -ge $closedDeadline) {
        throw "$Distro account setup exited, but its user is still not ready. $lastReadiness Open $Distro from the Start menu to finish account setup. If that also fails, run 'wsl --list --verbose' and 'wsl -d $Distro --exec id -u' for the actual WSL error. Your existing data is kept."
      }
      if ((Get-SetupTime) -ge $nextNotice) {
        Write-Host "Waiting for $Distro account setup. Finish its username/password prompts; if you already see a shell prompt, type exit there."
        $nextNotice = (Get-SetupTime).AddSeconds(15)
      }
      Start-Sleep -Seconds 1
    }
    throw "$Distro account setup hasn't finished. $lastReadiness Complete its setup, then run this installer again."
  } finally {
    if ($probe) { Stop-SetupProbe $probe }
    # A cancelled/timed-out check must not close an unfinished Ubuntu download or account form.
    $setup.Refresh()
    if ($accountReady -and -not $setup.HasExited) { Stop-Process -Id $setup.Id -ErrorAction SilentlyContinue }
    $setup.Dispose()
  }
}

# A new private file in the Linux user's home, which no other user of the distro can swap.
function Invoke-Installer([string[]]$Options) {
  $made = Invoke-Wsl -d $Distro --cd "~" --exec mktemp .localdot-install.XXXXXX
  if ($made.Code -ne 0 -or $made.Text -notmatch '^\.localdot-install\.[A-Za-z0-9]{6}$') {
    throw "Couldn't make a file for the installer inside ${Distro}: $($made.Text)"
  }
  $file = $made.Text
  try {
    $download = Invoke-Wsl -d $Distro --cd "~" --exec curl -fsSL -o $file $InstallUrl
    if ($download.Code -ne 0) { throw "Couldn't download the installer inside ${Distro}: $($download.Text)" }
    & wsl.exe -d $Distro --cd "~" --exec bash $file @Options
    if ($LASTEXITCODE -ne 0) { throw "localDot setup inside $Distro failed (exit $LASTEXITCODE). The specific cause and recovery steps are printed above. Completed setup and your data are kept; rerun the same installer after fixing that issue." }
  } finally {
    Invoke-Wsl -d $Distro --cd "~" --exec rm -f $file | Out-Null
  }
}

# WSL shuts a Linux down once no Windows program uses it; a hidden wsl.exe keeps its services up.
function Register-KeepRunning {
  New-Item -ItemType Directory -Force -Path (Split-Path $KeepRunning) | Out-Null
  Set-Content -Path $KeepRunning -Encoding ASCII -Value "CreateObject(`"WScript.Shell`").Run `"wsl.exe -d $Distro --exec sleep infinity`", 0, False"
  try {
    $known = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$KeepRunning`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Description "Keeps localDot's Linux running after you sign in to Windows." -Force | Out-Null
    if (-not $known) { Start-ScheduledTask -TaskName $TaskName }
  } catch {
    Write-Warning "localDot stops when Windows shuts its Linux down. To keep it running, open $Distro after you sign in."
  }
}

function Unregister-KeepRunning {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Force -ErrorAction SilentlyContinue $KeepRunning
  Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Distro --exec sleep infinity*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}

function Wait-Docker([int]$TimeoutSeconds = 1200) {
  $explained = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    # Check the same Linux environment that will run localDot, not merely docker.exe on Windows.
    $result = Invoke-Wsl -d $Distro --exec timeout 10 docker info --format '{{.ServerVersion}}/{{.OSType}}'
    if ($result.Code -eq 0 -and $result.Text -match '^(\d+)\.[^/]+/linux$') {
      if ([int]$Matches[1] -ge 28) {
        if ($explained) { Write-Host "Docker is ready in $Distro. Continuing installation..." }
        return $true
      }
    }
    if (-not $explained) {
      $explained = $true
      Write-Host ""
      Write-Host "Ubuntu is ready. One more step: connect Docker."
      Write-Host "1. Install or open Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/"
      Write-Host "2. In Docker Desktop, enable Settings > General > Use the WSL 2 based engine."
      Write-Host "3. Under Settings > Resources > WSL integration, enable $Distro and click Apply."
      Write-Host "Use Linux containers and Docker Engine 28 or newer. An existing Docker Engine inside $Distro works too."
      Write-Host ""
      Write-Host "Waiting for Docker in $Distro. Installation continues automatically; keep this window open."
      Write-Host "Press Ctrl+C to stop. Your Ubuntu setup is kept."
      $desktop = Find-DockerDesktop
      if (-not $desktop -and $result.Code -eq 127) {
        if (-not (Install-DockerDesktop)) { return $false }
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $desktop = Find-DockerDesktop
        if (-not $desktop) { throw "Docker setup finished but the app wasn't found. Open Docker Desktop, then rerun localDot setup." }
      }
      if ($desktop -and -not $NoPrerequisites) {
        try { Start-Process -FilePath $desktop | Out-Null } catch {
          Write-Host "Please open Docker Desktop from the Windows Start menu."
        }
      }
    }
    Start-Sleep -Seconds 3
  }
  Write-Host "Docker is still unavailable in $Distro. Finish the steps above, then rerun this installer."
  return $false
}

function Find-DockerDesktop {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe' }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Read-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Write-UserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }

function Install-Command {
  $bin = Join-Path $env:LOCALAPPDATA 'localDot\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $shim = Join-Path $bin 'localdot.cmd'
  if ((Test-Path $shim) -and -not ((Get-Content -Raw $shim) -match 'localDot command')) {
    Write-Warning "Another command exists at $shim; leaving it alone."
    return
  }
  # Distro is a WSL name, never shell input. Reject metacharacters before writing a cmd file.
  if ($Distro -notmatch '^[A-Za-z0-9._-]+$') { throw 'Unsupported WSL distribution name.' }
  Set-Content -Encoding ASCII -Path $shim -Value "@echo off`r`n@rem localDot command`r`nwsl.exe -d `"$Distro`" -- ~/.local/bin/localdot %*`r`nexit /b %errorlevel%"
  $userPath = Read-UserPath
  if (($userPath -split ';') -notcontains $bin) {
    Write-UserPath ((([string]$userPath).TrimEnd(';') + ';' + $bin).TrimStart(';'))
  }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
}

function Install-LocalDot {
  if ($InstallPrerequisites -and $NoPrerequisites) { throw "Choose either -InstallPrerequisites or -NoPrerequisites." }
  if ($Resume) { Write-Host "Resuming localDot setup. Completed steps will be reused." }
  if (-not (Enable-Wsl)) { return }
  if (-not (Initialize-Distro)) { return }
  $options = @()
  if ($Ref) { $options += "--ref", $Ref }
  if ($Tailscale) { $options += "--tailscale" }
  if ($Uninstall) {
    Invoke-Installer (@("--uninstall") + $options)
    Unregister-KeepRunning
    Remove-ItemProperty -Path $ResumeKey -Name localDotSetup -ErrorAction SilentlyContinue
    return
  }
  Ensure-LinuxTools
  if (-not (Wait-Docker)) { return }
  Invoke-Installer $options
  Install-Command
  Register-KeepRunning
  Remove-ItemProperty -Path $ResumeKey -Name 'localDotSetup' -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "localDot installation finished. Your app link is printed above."
  Write-Host "For a fresh sign-in link from PowerShell: localdot open"
}

if ($MyInvocation.InvocationName -ne ".") { Install-LocalDot }
