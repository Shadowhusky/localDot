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

# wsl.exe writes UTF-16 text unless WSL_UTF8 is set; older versions ignore it, hence the NULs.
function Invoke-Wsl {
  $env:WSL_UTF8 = "1"
  $output = & wsl.exe @args 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Text = (($output | Out-String) -replace "`0", "").Trim() }
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
    Start-Process -FilePath "wsl.exe" -ArgumentList "--install", "--no-distribution" -Verb RunAs -Wait
    Write-Host "Restart Windows to finish turning on WSL, then run this installer again."
    return $false
  }
  # systemd needs the WSL from the Microsoft Store; the one built into older Windows lacks --version.
  if ((Invoke-Wsl --version).Code -ne 0) {
    Write-Host "Updating WSL."
    & wsl.exe --update | Out-Host
  }
  return $true
}

function Initialize-Distro {
  $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
  if ($found.Count -eq 0) {
    Write-Host "Installing $Distro. Create your Linux user name and password when it asks. If you then see a Linux prompt, type exit to continue."
    & wsl.exe --install --distribution $Distro
    if ($LASTEXITCODE -ne 0) { throw "Installing $Distro didn't finish. Run this installer again." }
    $found = @(Get-WslDistros | Where-Object { $_.Name -eq $Distro })
    if ($found.Count -eq 0) { throw "$Distro isn't set up yet. Open it once from the Start menu to create your user, then run this installer again." }
  }
  if ($found[0].Version -eq "1") {
    Write-Host "Moving $Distro to WSL 2."
    & wsl.exe --set-version $Distro 2
    if ($LASTEXITCODE -ne 0) { throw "Moving $Distro to WSL 2 failed." }
  }
  if ((Invoke-Wsl -d $Distro --exec id -u).Text -eq "0") {
    throw "$Distro signs in as root. Create your own user in it and make that the default; see docs/install.md."
  }
  if ((Invoke-Wsl -d $Distro --exec test -d /run/systemd/system).Code -ne 0) {
    Write-Host "Turning on systemd in $Distro."
    $result = Invoke-Wsl -d $Distro -u root --exec sh -c $EnableSystemd
    if ($result.Code -ne 0) { throw "Couldn't turn on systemd in ${Distro}: $($result.Text)" }
    & wsl.exe --terminate $Distro | Out-Null
  }
}

function Invoke-Installer([string[]]$Options) {
  $download = Invoke-Wsl -d $Distro --exec curl -fsSL -o /tmp/localdot-install.sh $InstallUrl
  if ($download.Code -ne 0) { throw "Couldn't download the installer inside ${Distro}: $($download.Text)" }
  & wsl.exe -d $Distro --cd "~" --exec bash /tmp/localdot-install.sh @Options
  if ($LASTEXITCODE -ne 0) { throw "The installer inside $Distro stopped; see its message above." }
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
  Write-Host "localDot runs inside $Distro. For a fresh sign-in link, run: wsl -d $Distro -- ~/.local/bin/localdot open"
}

if ($MyInvocation.InvocationName -ne ".") { Install-LocalDot }
