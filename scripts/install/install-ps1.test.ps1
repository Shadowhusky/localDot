# Checks install.ps1 against a pretend wsl.exe and Task Scheduler, including Windows PowerShell
# 5.1's native stderr behavior. Also runs on PowerShell 7 on other platforms.
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
    InstallAdds = $null; TaskExists = $false; Stderr = $false; Update = 0; ElevatedExit = 0
    SetupExited = $false; SetupExit = 0; ProbeUids = @("0", "1000"); ProbePending = $false
    DockerResponses = @("29.2.0/linux"); Desktop = $null
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
    "^--status$" {
      $code = $script:machine.Status
      if ($script:machine.Stderr) { Write-Error "WSL is not installed. Run wsl --install." }
    }
    "^--update$" { $code = $script:machine.Update }
    "^--version$" { $code = $script:machine.Version }
    "^--list --verbose$" {
      # Older wsl.exe writes UTF-16, which arrives with NULs between characters.
      $text = "  NAME      STATE           VERSION`n" + (($script:machine.Distros | ForEach-Object { "* $($_[0])    Stopped         $($_[1])" }) -join "`n")
      $out = ($text.ToCharArray() | ForEach-Object { "$_`0" }) -join ""
    }
    "^--install --distribution (\S+)$" { if ($script:machine.InstallAdds) { $script:machine.Distros += , $script:machine.InstallAdds } }
    "--exec id -u$" { $out = $script:machine.Uid }
    "--exec timeout 10 docker info " {
      $out = $script:machine.DockerResponses[0]
      if ($script:machine.DockerResponses.Count -gt 1) {
        $script:machine.DockerResponses = @($script:machine.DockerResponses | Select-Object -Skip 1)
      }
      if ($out -eq "missing") { $code = 127 }
      if ($out -eq "timeout") { $code = 124 }
    }
    "--exec test -d /run/systemd/system$" { $code = $script:machine.Systemd }
    "--exec mktemp \.localdot-install\.XXXXXX$" { $out = ".localdot-install.Ab12Cd" }
    "--exec curl " { $code = $script:machine.Download }
    "--exec bash \.localdot-install\.Ab12Cd" { $code = $script:machine.Installer }
  }
  $global:LASTEXITCODE = $code
  if ($out) { $out }
}
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  $script:calls.Add("Start-Process $FilePath $($ArgumentList -join ' ') $Verb")
  if ($Verb -eq "RunAs") {
    if ($PassThru) { [pscustomobject]@{ ExitCode = $script:machine.ElevatedExit } }
    return
  }
  if ($script:machine.InstallAdds) { $script:machine.Distros += , $script:machine.InstallAdds }
  $process = [pscustomobject]@{ Id = 123456; HasExited = $script:machine.SetupExited; ExitCode = $script:machine.SetupExit }
  $process | Add-Member ScriptMethod Refresh { }
  $process | Add-Member ScriptMethod Dispose { }
  $process
}
function Start-Job {
  param($ArgumentList, $ScriptBlock)
  $script:calls.Add("Start-Job user probe $ArgumentList")
  [pscustomobject]@{ State = $(if ($script:machine.ProbePending) { "Running" } else { "Completed" }) }
}
function Receive-Job {
  param($Job)
  $value = $script:machine.ProbeUids[0]
  $script:machine.ProbeUids = @($script:machine.ProbeUids | Select-Object -Skip 1)
  $value
}
function Remove-Job { param($Job, [switch]$Force) $script:calls.Add("Remove-Job") }
function Stop-Job { param($Job) $script:calls.Add("Stop-Job") }
function Start-Sleep { param($Seconds) if ($script:machine.ProbePending) { throw "Cancelled setup" } }
function Stop-Process { param($Id) $script:calls.Add("Stop-Process $Id") }
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

# Never change the tester's persistent user PATH.
$script:userPath = 'C:\Existing\bin'
function Read-UserPath { $script:userPath }
function Write-UserPath([string]$Value) { $script:userPath = $Value }

# Registry writes stay inside the test harness, including on actual Windows runners.
function New-Item {
  param($Path, $ItemType, [switch]$Force)
  if ($Path -like 'HKCU:*') { return }
  Microsoft.PowerShell.Management\New-Item -Path $Path -ItemType $ItemType -Force:$Force
}
function New-ItemProperty { param($Path, $Name, $PropertyType, $Value, [switch]$Force) $script:calls.Add("Registry $Name $Value") }
function Remove-ItemProperty { param($Path, $Name) $script:calls.Add("Remove registry $Name") }

# Dot-sourcing replaced the build check; put the pretend one back.
function Get-WindowsBuild { 22631 }

function Find-DockerDesktop { $script:machine.Desktop }

Reset-Machine @{ DockerResponses = @("missing", "27.0.0/linux", "29.2.0/windows", "29.2.0/linux"); Desktop = "test-docker-desktop.exe" }
Check (Wait-Docker) "continues once Docker becomes available in Ubuntu with the required Linux engine"
Check (@($script:calls | Where-Object { $_ -like '*--exec timeout 10 docker info*' }).Count -eq 4) "rejects missing Docker, old engines and Windows container mode"
Check (@($script:calls | Where-Object { $_ -like 'Start-Process test-docker-desktop.exe*' }).Count -eq 1) "opens installed Docker Desktop only once while waiting"

Reset-Machine @{}
Check (Wait-Docker) "uses an existing Linux Docker engine without extra setup"
Check (-not (@($script:calls) -match 'Start-Process')) "does not launch Desktop when Docker already works"
Check (-not (Wait-Docker -TimeoutSeconds 0)) "returns a resumable setup state on timeout"

# Actual prerequisite installation code, with downloaded files and processes simulated.
& {
  $InstallPrerequisites = [switch]$true
  $NoPrerequisites = [switch]$false
  $env:PROCESSOR_ARCHITECTURE = 'AMD64'
  $env:PROCESSOR_ARCHITEW6432 = ''
  $script:digest = 'a9814e31049d66156477a86614e83365669677733014ec72f74229623ff3890a'
  $script:signature = 'Valid'
  $script:dockerExit = 0
  function Receive-SetupFile { param($Url, $Path) $script:calls.Add("Download $Url"); Set-Content $Path 'fixture' }
  function Get-FileHash { param($Path, $Algorithm) [pscustomobject]@{ Hash = $script:digest } }
  function Get-AuthenticodeSignature { param($Path) [pscustomobject]@{ Status = $script:signature } }
  function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    $script:calls.Add("Docker install $($ArgumentList -join ' ')")
    [pscustomobject]@{ ExitCode = $script:dockerExit }
  }
  Reset-Machine @{}
  Check (Install-DockerDesktop) "installs verified Docker Desktop and continues"
  Check ($script:calls -contains 'Docker install install --user --backend=wsl-2') "uses per-user WSL installation without accepting the license"
  $script:digest = 'bad'
  Reset-Machine @{}
  $message = ''
  try { Install-DockerDesktop | Out-Null } catch { $message = $_.Exception.Message }
  Check ($message -like '*verification failed*' -and -not (@($script:calls) -match '^Docker install')) "rejects a corrupt download before executing it"
  $script:digest = 'a9814e31049d66156477a86614e83365669677733014ec72f74229623ff3890a'
  $script:signature = 'NotTrusted'
  Reset-Machine @{}
  $message = ''
  try { Install-DockerDesktop | Out-Null } catch { $message = $_.Exception.Message }
  Check ($message -like '*signature*' -and -not (@($script:calls) -match '^Docker install')) "rejects an untrusted installer signature"
  $script:signature = 'Valid'
  $script:dockerExit = 3010
  Reset-Machine @{}
  Check (-not (Install-DockerDesktop)) "saves a continuation instead of claiming success when Docker needs a restart"
  Check (@($script:calls | Where-Object { $_ -like 'Registry localDotSetup*' }).Count -eq 1) "registers Docker's restart continuation"
  $script:dockerExit = 1
  $message = ''
  try { Install-DockerDesktop | Out-Null } catch { $message = $_.Exception.Message }
  Check ($message -like '*exit 1*') "reports a failed Docker installer"
  $NoPrerequisites = [switch]$true
  Reset-Machine @{}
  Check (-not (Install-DockerDesktop)) "manual prerequisite mode declines Docker installation"
  Check ($script:calls.Count -eq 0) "manual mode never downloads or executes Docker setup"
}

Reset-Machine @{ DockerResponses = @('timeout', '29.2.0/linux') }
Check (Wait-Docker) "continues after a slow existing engine responds"
Check (-not (@($script:calls) -match 'Start-Process')) "does not install Desktop because an engine probe timed out"

Reset-Machine @{ Status = 1; Stderr = $true }
$savedEncoding = [Console]::OutputEncoding
$savedUtf8 = $env:WSL_UTF8
$probe = Invoke-Wsl --status
Check ($probe.Code -eq 1 -and $probe.Text -like "*WSL is not installed*") "captures a failing WSL probe without terminating on stderr"
Check ($ErrorActionPreference -eq "Stop") "preserves the caller's error handling"
Check ([Console]::OutputEncoding.CodePage -eq $savedEncoding.CodePage -and $env:WSL_UTF8 -eq $savedUtf8) "restores console encoding and WSL environment"
$ready = Enable-Wsl
$savedOptions = Get-Content (Join-Path $SetupDirectory 'options.json') -Raw | ConvertFrom-Json
Check ($savedOptions.Resume -and $savedOptions.Distro -eq 'Ubuntu') "persists setup options for resuming after restart"
Check (@($script:calls | Where-Object { $_ -like 'Registry localDotSetup powershell.exe*' }).Count -eq 1) "registers a visible one-time continuation"
Check (Test-Path (Join-Path $SetupDirectory 'install.ps1')) "saves installer locally before asking for a restart"
Check (-not $ready) "asks Windows to turn on WSL when it is off, and stops for a restart"
Check ($script:calls -match "Start-Process wsl.exe --install --no-distribution RunAs").Count "turns WSL on elevated, without a distribution"

Reset-Machine @{ Status = 1; ElevatedExit = 1 }
$message = ""
try { Enable-Wsl | Out-Null } catch { $message = $_.Exception.Message }
Check ($message -like "*WSL setup didn't finish*") "reports failed elevated setup instead of claiming a restart will fix it"

Reset-Machine @{ Status = 1; ElevatedExit = 3010 }
Check (-not (Enable-Wsl)) "accepts Windows' reboot-required success code"

Reset-Machine @{ Version = 1; Update = 1 }
$message = ""
try { Enable-Wsl | Out-Null } catch { $message = $_.Exception.Message }
Check ($message -like "*Couldn't update WSL*") "does not continue after a failed WSL update"

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
Check (@($calls | Where-Object { $_ -like "Start-Process wsl.exe --install --distribution Ubuntu*" }).Count -eq 1) "installs Ubuntu in its own setup window"
Check (-not ($calls -contains "wsl --install --distribution Ubuntu")) "never blocks the installer in Ubuntu's interactive shell"
Check (@($calls | Where-Object { $_ -eq "Start-Job user probe Ubuntu" }).Count -eq 2) "waits until account setup replaces root with the user's account"
Check ($calls.IndexOf("Stop-Process 123456") -lt $calls.IndexOf("wsl -d Ubuntu --cd ~ --exec mktemp .localdot-install.XXXXXX")) "closes only the owned setup window before continuing installation"
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

Reset-Machine @{ SetupExited = $true; SetupExit = 3010 }
Install-LocalDot
Check (@($script:calls | Where-Object { $_ -like 'Registry localDotSetup*' }).Count -eq 1) "resumes when distribution installation requires a restart"
Check (-not (@($script:calls) -match '--exec bash')) "does not continue app installation before the required restart"

Reset-Machine @{ SetupExited = $true; SetupExit = 1 }
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*Installing Ubuntu didn't finish*") "reports setup failure instead of waiting forever"
Check (-not (@($script:calls) -match "--exec bash")) "never reports an app install after failed Ubuntu setup"

Reset-Machine @{ SetupExited = $true; InstallAdds = @("Ubuntu", "2") }
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*setup closed before a Linux user was ready*") "reports a closed setup window without waiting for the timeout"

Reset-Machine @{ InstallAdds = @("Ubuntu", "2"); ProbePending = $true }
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -eq "Cancelled setup") "allows cancellation while WSL waits for account setup"
Check ($script:calls -contains "Stop-Job" -and $script:calls -contains "Stop-Process 123456") "cleans up the pending probe and only its own setup process"

Reset-Machine @{ TaskExists = $true }
$machine.Distros = @(, @("Ubuntu", "1"))
Install-LocalDot
Check ($script:calls -contains "wsl --set-version Ubuntu 2") "moves a WSL 1 distro to WSL 2"
Check (-not ($script:calls -contains "Start-ScheduledTask localDot")) "doesn't start a second keep-alive on an upgrade"
Check (-not (@($script:calls) -match "--exec sh -c .*systemd=true")) "leaves systemd alone when it is already on"

Reset-Machine @{ Uid = "0" }
$machine.Distros = @(, @("Ubuntu", "2"))
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*signs in as root*") "refuses a distro that signs in as root"

Reset-Machine @{ Installer = 1 }
$machine.Distros = @(, @("Ubuntu", "2"))
$message = ""
try { Install-LocalDot } catch { $message = $_.Exception.Message }
Check ($message -like "*inside Ubuntu failed (exit 1)*" -and $message -like "*data are kept*") "reports a failed Linux install with its exit code and recovery guidance"
Check ($script:calls -contains "wsl -d Ubuntu --cd ~ --exec rm -f .localdot-install.Ab12Cd") "removes the file after a failed install too"
Check (-not (@($script:calls) -match "Register-ScheduledTask")) "registers nothing after a failed install"

Reset-Machine @{}
$machine.Distros = @(, @("Ubuntu", "2"))
$Uninstall = [switch]$true
Install-LocalDot
$Uninstall = [switch]$false
Check ($script:calls -contains "wsl -d Ubuntu --cd ~ --exec bash .localdot-install.Ab12Cd --uninstall") "uninstalls inside Linux"
Check ($script:calls -contains "Unregister-ScheduledTask localDot") "removes the keep-alive task"
Check (-not (@($script:calls) -match '--exec timeout 10 docker info')) "uninstall does not wait for Docker"

Check (-not $EnableSystemd.Contains('"')) "passes the systemd edit without double quotes"
# The systemd edit runs inside Linux and intentionally uses GNU sed, not macOS BSD sed.
if ((Test-Path /proc/sys/kernel/ostype) -and (Get-Command sh -CommandType Application -ErrorAction SilentlyContinue)) {
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
# Force an unsupported build even on Windows: never invoke real setup from this entry-point test.
try { ((Get-Content $installer -Raw) -replace '\[Environment\]::OSVersion.Version.Build', '0') | Invoke-Expression } catch { $message = $_.Exception.Message }
Check ($message -like "*Windows 10 version 2004*") "runs when piped into Invoke-Expression"

# Exercise a real native stderr stream, not just a PowerShell function mock. The outer 2>&1
# reproduces the screenshot's NativeCommandError on Windows PowerShell 5.1 before this fix.
if ($env:OS -eq "Windows_NT") {
  function wsl.exe { & $env:ComSpec /d /c "echo WSL is not installed. 1>&2 & exit /b 1" }
  $probe = Invoke-Wsl --status
  Check ($probe.Code -eq 1 -and $probe.Text -like "*WSL is not installed*") "real native stderr reaches the exit-code check on Windows"
  # Compile a native .NET executable on 5.1 to exercise both streams with Chinese text. ASCII
  # source escapes also keep this test readable by Windows PowerShell's legacy script decoder.
  if ($PSVersionTable.PSVersion.Major -eq 5) {
    $script:nativeProbe = Join-Path $env:LOCALAPPDATA "wsl-probe.exe"
    Add-Type -OutputAssembly $script:nativeProbe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Text;
public class Probe {
  public static int Main() {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.WriteLine("\u4f60\u597d stdout");
    Console.Error.WriteLine("\u4f60\u597d stderr");
    return 1;
  }
}
'@
    function wsl.exe { & $script:nativeProbe }
    $probe = Invoke-Wsl --status
    $hello = [string][char]0x4f60 + [char]0x597d
    Check ($probe.Code -eq 1 -and $probe.Text.Contains("$hello stdout") -and $probe.Text.Contains("$hello stderr")) "decodes UTF-8 stdout and native stderr without garbling localized text"
    Check ([Console]::OutputEncoding.CodePage -eq $savedEncoding.CodePage -and $env:WSL_UTF8 -eq $savedUtf8) "restores encoding after real native stderr"
  }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $env:LOCALAPPDATA
if ($script:failures -gt 0) { Write-Host "$script:failures failed"; exit 1 }
Write-Host "all passed"
# The final native fixture deliberately exits 1. Do not let the CI shell reuse that status.
exit 0
