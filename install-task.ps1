param(
  [string]$TaskName = "Nekomachi OSIRO Event Check",
  [string]$Time = "00:00"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$RegisterScript = Join-Path $ProjectRoot "scripts\register-task.ps1"

if (-not (Test-Path -LiteralPath $RegisterScript)) {
  throw "Task registration script was not found: $RegisterScript"
}

& $RegisterScript -TaskName $TaskName -Time $Time
