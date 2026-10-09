# Checks install.ps1 against a pretend wsl.exe and Task Scheduler. Runs on any PowerShell 7,
# Windows or not: pwsh -NoProfile -File scripts/install/install-ps1.test.ps1
$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "../../install.ps1"
$script:failures = 0

function Check([bool]$ok, [string]$name) {
  if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:failures++ }
}

$env:LOCALAPPDATA = Join-Path ([IO.Path]::GetTempPath()) ("localdot-ps1-" + [guid]::NewGuid())

# Each scenario sets these, then wsl.exe answers from them.
function Reset-Machine([hashtable]$machine) {
  $script:machine = @{
    Status = 0; Version = 0; Distros = @(); Uid = "1000"; Systemd = 0; Download = 0; Installer = 0
    InstallAdds = $null; TaskExists = $false
  }
  foreach ($key in $machine.Keys) { $script:machine[$key] = $machine[$key] }
  $script:calls = [System.Collections.Generic.List[string]]::new()
}

function wsl.exe {
  $line = $args -join " "
  $script:calls.Add("wsl $line")
  $code = 0
  $out = ""
  switch -Regex ($line) {
    "^--status$" { $code = $script:machine.Status }
    "^--version$" { $code = $script:machine.Version }
    "^--list --verbose$" {
      # Older wsl.exe writes UTF-16, which arrives with NULs between characters.
      $text = "  NAME      STATE           VERSION`n" + (($script:machine.Distros | ForEach-Object { "* $($_[0])    Stopped         $($_[1])" }) -join "`n")
      $out = ($text.ToCharArray() | ForEach-Object { "$_`0" }) -join ""
    }
    "^--install --distribution (\S+)$" { if ($script:machine.InstallAdds) { $script:machine.Distros += , $script:machine.InstallAdds } }
    "--exec id -u$" { $out = $script:machine.Uid }
    "--exec test -d /run/systemd/system$" { $code = $script:machine.Systemd }
    "--exec mktemp \.localdot-install\.XXXXXX$" { $out = ".localdot-install.Ab12Cd" }
    "--exec curl " { $code = $script:machine.Download }
    "--exec bash \.localdot-install\.Ab12Cd" { $code = $script:machine.Installer }
  }
  $global:LASTEXITCODE = $code
  if ($out) { $out }
}
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait) $script:calls.Add("Start-Process $FilePath $($ArgumentList -join ' ') $Verb") }
function Get-WindowsBuild { 22631 }
function Get-ScheduledTask { if ($script:machine.TaskExists) { "task" } }
function New-ScheduledTaskAction { param($Execute, $Argument) "$Execute $Argument" }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) "logon" }
function New-ScheduledTaskSettingsSet { "settings" }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Settings, $Description, [switch]$Force) $script:calls.Add("Register-ScheduledTask $TaskName $Action") }
function Start-ScheduledTask { param($TaskName) $script:calls.Add("Start-ScheduledTask $TaskName") }
function Unregister-ScheduledTask { param($TaskName, $Confirm) $script:calls.Add("Unregister-ScheduledTask $TaskName") }
function Get-CimInstance { }

. $installer

# Dot-sourcing replaced the build check; put the pretend one back.
function Get-WindowsBuild { 22631 }

Reset-Machine @{ Status = 1 }
$ready = Enable-Wsl
Check (-not $ready) "asks Windows to turn on WSL when it is off, and stops for a restart"
Check ($script:calls -match "Start-Process wsl.exe --install --no-distribution RunAs").Count "turns WSL on elevated, without a distribution"

Reset-Machine @{ Version = 1 }
Enable-Wsl | Out-Null
Check ($script:calls -contains "wsl --update") "updates an inbox WSL that can't run systemd"

Reset-Machine @{}
$machine.Distros = @(@("Ubuntu", "2"), @("Debian", "1"))
$distros = @(Get-WslDistros)
Check ($distros.Count -eq 2 -and $distros[0].Name -eq "Ubuntu" -and $distros[1].Version -eq "1") "reads the distro list through UTF-16 NULs and the default marker"

Reset-Machine @{ Systemd = 1; InstallAdds = @("Ubuntu", "2") }
$Ref = "v1.2.3"; $Tailscale = [switch]$true
Install-LocalDot
$calls = @($script:calls)
Check ($calls -contains "wsl --install --distribution Ubuntu") "installs Ubuntu when it is missing"
Check (@($calls | Where-Object { $_ -like "wsl -d Ubuntu -u root --exec sh -c *systemd=true*" }).Count -eq 1) "turns on systemd as root"
Check ($calls -contains "wsl --terminate Ubuntu") "restarts the distro so systemd starts"
Check ($calls -contains "wsl -d Ubuntu --cd ~ --exec mktemp .localdot-install.XXXXXX") "makes a private file for install.sh in the Linux home"
Check ($calls -contains "wsl -d Ubuntu --cd ~ --exec curl -fsSL -o .localdot-install.Ab12Cd https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh") "downloads install.sh into it"
Check ($calls -contains "wsl -d Ubuntu --cd ~ --exec bash .localdot-install.Ab12Cd --ref v1.2.3 --tailscale") "runs install.sh with the chosen options"
Check ($calls -contains "wsl -d Ubuntu --cd ~ --exec rm -f .localdot-install.Ab12Cd") "removes the file afterwards"
Check (@($calls | Where-Object { $_ -like "Register-ScheduledTask localDot wscript.exe *keep-running.vbs*" }).Count -eq 1) "keeps Linux running after sign-in"
Check ($calls -contains "Start-ScheduledTask localDot") "starts it now the first time"
$vbs = Get-Content (Join-Path $env:LOCALAPPDATA "localDot/keep-running.vbs") -Raw
Check ($vbs -match '\.Run "wsl\.exe -d Ubuntu --exec sleep infinity", 0, False') "runs the keep-alive hidden"
$Ref = $null; $Tailscale = [switch]$false

Reset-Machine @{ TaskExists = $true }
$machine.Distros = @(, @("Ubuntu", "1"))
Install-LocalDot
Check ($script:calls -contains "wsl --set-version Ubuntu 2") "moves a WSL 1 distro to WSL 2"
Check (-not ($script:calls -contains "Start-ScheduledTask localDot")) "doesn't start a second keep-alive on an upgrade"
Check (-not (@($script:calls) -match "--exec sh -c")) "leaves systemd alone when it is already on"

Reset-Machine @{ Uid = "0" }
$machine.Distros = @(, @("Ubuntu", "2"))
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*signs in as root*") "refuses a distro that signs in as root"

Reset-Machine @{ Installer = 1 }
$machine.Distros = @(, @("Ubuntu", "2"))
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*installer inside Ubuntu stopped*") "reports a failed Linux install"
Check ($script:calls -contains "wsl -d Ubuntu --cd ~ --exec rm -f .localdot-install.Ab12Cd") "removes the file after a failed install too"
Check (-not (@($script:calls) -match "Register-ScheduledTask")) "registers nothing after a failed install"

Reset-Machine @{}
$machine.Distros = @(, @("Ubuntu", "2"))
$Uninstall = [switch]$true
Install-LocalDot
$Uninstall = [switch]$false
Check ($script:calls -contains "wsl -d Ubuntu --cd ~ --exec bash .localdot-install.Ab12Cd --uninstall") "uninstalls inside Linux"
Check ($script:calls -contains "Unregister-ScheduledTask localDot") "removes the keep-alive task"

Check (-not $EnableSystemd.Contains('"')) "passes the systemd edit without double quotes"
if (Get-Command sh -CommandType Application -ErrorAction SilentlyContinue) {
  $conf = Join-Path $env:LOCALAPPDATA "wsl.conf"
  $edit = $EnableSystemd.Replace("/etc/wsl.conf", $conf)
  foreach ($case in @(
      @{ Before = $null; After = "`n[boot]`nsystemd=true`n" },
      @{ Before = "[boot]`ncommand=echo`n"; After = "[boot]`nsystemd=true`ncommand=echo`n" },
      @{ Before = "[user]`ndefault=ana`n[boot]`nsystemd=false`n"; After = "[user]`ndefault=ana`n[boot]`nsystemd=true`n" }
    )) {
    Remove-Item -Force -ErrorAction SilentlyContinue $conf
    if ($null -ne $case.Before) { [IO.File]::WriteAllText($conf, $case.Before) }
    & sh -c $edit
    Check ([IO.File]::ReadAllText($conf) -eq $case.After) "turns systemd on in wsl.conf starting as '$($case.Before)'"
  }
}

# Piped in, the script defines its own build check again, which off Windows refuses: that refusal
# shows it ran.
Reset-Machine @{}
$message = ""
try { Get-Content $installer -Raw | Invoke-Expression } catch { $message = $_.Exception.Message }
Check ($message -like "*Windows 10 version 2004*") "runs when piped into Invoke-Expression"

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $env:LOCALAPPDATA
if ($script:failures -gt 0) { Write-Host "$script:failures failed"; exit 1 }
Write-Host "all passed"
