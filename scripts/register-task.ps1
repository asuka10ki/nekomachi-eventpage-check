param(
  [string]$TaskName = "Nekomachi OSIRO Event Check",
  [string]$Time = "00:00"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $ProjectRoot "scripts\run-check.ps1"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "run-check.ps1 was not found: $ScriptPath"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
  -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Checks OSIRO event settings and posts the result to Slack." `
  -Force

Write-Host "Registered task: $TaskName"
Write-Host "Daily time: $Time"
Write-Host "Project: $ProjectRoot"
