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
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$InstallUrl = "https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh"
$TaskName = "localDot"
$KeepRunning = Join-Path $env:LOCALAPPDATA "localDot\keep-running.vbs"

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
  $list = Invoke-Wsl --list --verbose
  if ($list.Code -ne 0) { return @() }
  foreach ($line in ($list.Text -split "`r?`n" | Select-Object -Skip 1)) {
    $fields = @(($line -replace '^\s*\*?\s*', '').Trim() -split '\s+')
    if ($fields.Count -ge 3) { [pscustomobject]@{ Name = $fields[0]; Version = $fields[-1] } }
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
    Write-Host "Turning on WSL 2. Windows asks for permission first."
    $install = Start-Process -FilePath "wsl.exe" -ArgumentList "--install", "--no-distribution" -Verb RunAs -Wait -PassThru
    if ($install.ExitCode -notin @(0, 3010)) {
      throw "WSL setup didn't finish (exit $($install.ExitCode)). Open PowerShell as administrator, run 'wsl --install --no-distribution', restart Windows, then run this installer again."
    }
    Write-Host "Restart Windows to finish turning on WSL, then run this installer again."
    return $false
  }
  # systemd needs the WSL from the Microsoft Store; the one built into older Windows lacks --version.
  if ((Invoke-Wsl --version).Code -ne 0) {
    Write-Host "Updating WSL."
    $update = Invoke-Wsl --update
    if ($update.Code -ne 0) { throw "Couldn't update WSL. Run 'wsl --update' in PowerShell as administrator, then run this installer again." }
  }
  return $true
}

function Initialize-Distro {
  $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
  if ($found.Count -eq 0) {
    Install-Distro
    $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
    if ($found.Count -eq 0) { throw "$Distro isn't set up yet. Open it once from the Start menu to create your user, then run this installer again." }
  }
  if ($found[0].Version -eq "1") {
    Write-Host "Moving $Distro to WSL 2."
    & wsl.exe --set-version $Distro 2
    if ($LASTEXITCODE -ne 0) { throw "Moving $Distro to WSL 2 failed." }
  }
  $user = Invoke-Wsl -d $Distro --exec id -u
  if ($user.Code -ne 0 -or $user.Text -notmatch '^\d+$') {
    throw "Couldn't start $Distro. Run 'wsl -d $Distro' to check its setup, then rerun this installer."
  }
  if ($user.Text -eq "0") {
    throw "$Distro signs in as root. Create your own user in it and make that the default; see docs/install.md."
  }
  if ((Invoke-Wsl -d $Distro --exec test -d /run/systemd/system).Code -ne 0) {
    Write-Host "Turning on systemd in $Distro."
    $result = Invoke-Wsl -d $Distro -u root --exec sh -c $EnableSystemd
    if ($result.Code -ne 0) { throw "Couldn't turn on systemd in ${Distro}: $($result.Text)" }
    & wsl.exe --terminate $Distro | Out-Null
  }
}

function Install-Distro {
  # Keep the installer in PowerShell while WSL runs its normal, interactive account setup.
  # Supplying --exec skips WSL's OOBE, so it cannot replace this first interactive launch.
  # Distro names become one Windows command-line argument, never shell input.
  if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid distribution name: $Distro" }
  Write-Host "Installing $Distro in a setup window. Create your Linux user name and password there."
  Write-Host "Keep this PowerShell window open. localDot will continue here automatically after account setup."
  $setup = Start-Process -FilePath "wsl.exe" -ArgumentList "--install", "--distribution", $Distro -PassThru
  $probe = $null
  $deadline = (Get-Date).AddMinutes(30)
  try {
    while ((Get-Date) -lt $deadline) {
      $setup.Refresh()
      if ($setup.HasExited -and $setup.ExitCode -ne 0) {
        throw "Installing $Distro didn't finish (exit $($setup.ExitCode)). Run this installer again."
      }
      if (-not $probe -and @(Get-WslDistros | Where-Object { $_.Name -eq $Distro }).Count -gt 0) {
        # A WSL request can wait for OOBE's lock. Run the read-only probe asynchronously so
        # cancellation, setup failure and timeout remain responsive while the user types.
        $probe = Start-Job -ArgumentList $Distro -ScriptBlock {
          param($Name)
          $env:WSL_UTF8 = "1"
          [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
          $ErrorActionPreference = "Continue"
          $PSNativeCommandUseErrorActionPreference = $false
          $uidText = & wsl.exe -d $Name --exec id -u 2>$null
          if ($LASTEXITCODE -eq 0) { (($uidText -join "") -replace "`0", "").Trim() }
        }
      }
      if ($probe -and $probe.State -in @("Completed", "Failed", "Stopped")) {
        $uidText = ((Receive-Job $probe -ErrorAction SilentlyContinue) -join "").Trim()
        Remove-Job $probe -Force
        $probe = $null
        if ($uidText -match '^\d+$' -and $uidText -ne "0") {
          Write-Host "$Distro account is ready. Continuing localDot installation..."
          return
        }
        if ($setup.HasExited) {
          throw "$Distro setup closed before a Linux user was ready. Open $Distro from the Start menu to finish account setup, then rerun this installer."
        }
      }
      Start-Sleep -Seconds 1
    }
    throw "$Distro account setup hasn't finished. Complete its setup, then run this installer again."
  } finally {
    if ($probe) { Stop-Job $probe; Remove-Job $probe -Force }
    # Close only the setup client we launched. Never terminate the distro or other terminals.
    $setup.Refresh()
    if (-not $setup.HasExited) { Stop-Process -Id $setup.Id -ErrorAction SilentlyContinue }
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
    if ($LASTEXITCODE -ne 0) { throw "The installer inside $Distro stopped; see its message above." }
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

function Install-LocalDot {
  if (-not (Enable-Wsl)) { return }
  Initialize-Distro
  $options = @()
  if ($Ref) { $options += "--ref", $Ref }
  if ($Tailscale) { $options += "--tailscale" }
  if ($Uninstall) {
    Invoke-Installer (@("--uninstall") + $options)
    Unregister-KeepRunning
    return
  }
  Invoke-Installer $options
  Register-KeepRunning
  Write-Host ""
  Write-Host "localDot installation finished. Your app link is printed above."
  Write-Host "For a fresh sign-in link from PowerShell: wsl -d $Distro -- ~/.local/bin/localdot open"
}

if ($MyInvocation.InvocationName -ne ".") { Install-LocalDot }
