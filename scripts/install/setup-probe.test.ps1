# Real subprocess tests. These exercise stream draining and cancellation, not WSL itself.
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = [IO.Path]::GetTempPath() }
. (Join-Path $PSScriptRoot '../../install.ps1')
$runtime = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
function Start-TestProbe([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  Start-SetupProbe $runtime "-NoProfile -NonInteractive -EncodedCommand $encoded"
}
function Await-Probe($Probe) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $result = Read-SetupProbe $Probe
    if ($null -ne $result) { return $result }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Native probe failed to finish within its deadline' }
    Start-Sleep -Milliseconds 50
  } while ($true)
}
$probe = Start-TestProbe '[Console]::Error.Write(("x" * 200000)); [Console]::Out.WriteLine("1000"); exit 0'
try {
  $result = Await-Probe $probe
  if ($result.Code -ne 0 -or $result.Text -ne '1000') { throw 'Large stderr blocked or polluted the readiness result' }
  Write-Host 'ok   drains both native streams without deadlocking'
} finally { Stop-SetupProbe $probe }
$probe = Start-TestProbe '[Console]::Error.WriteLine("not ready"); exit 7'
try {
  $result = Await-Probe $probe
  if ($result.Code -ne 7 -or $result.Text -ne 'not ready') { throw 'Native failure was not preserved' }
  Write-Host 'ok   preserves native errors and exit codes'
} finally { Stop-SetupProbe $probe }
$probe = Start-TestProbe 'Start-Sleep -Seconds 60'
$ownedId = $probe.Process.Id
try {
  if ($null -ne (Read-SetupProbe $probe)) { throw 'A running process was reported as completed' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
} finally { Stop-SetupProbe $probe }
if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Cancellation blocked' }
if (Get-Process -Id $ownedId -ErrorAction SilentlyContinue) { throw 'Cancelled probe was left running' }
Write-Host 'ok   cancels the owned native process promptly'
Write-Host 'all passed'
exit 0
