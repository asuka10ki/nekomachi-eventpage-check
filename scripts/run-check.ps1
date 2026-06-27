$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$LogDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "check-$Stamp.log"

function Write-LogLine {
  param([string]$Message)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  $line | Tee-Object -FilePath $LogPath -Append
}

try {
  Write-LogLine "Starting OSIRO event check"
  Write-LogLine "ProjectRoot: $ProjectRoot"

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".env"))) {
    throw ".env was not found. Copy .env.example to .env and set Slack values."
  }

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "storageState.json"))) {
    throw "storageState.json was not found. Run npm run auth once before scheduling."
  }

  & npm run check 2>&1 | Tee-Object -FilePath $LogPath -Append
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    throw "npm run check failed with exit code $exitCode"
  }

  Write-LogLine "Finished successfully"
  exit 0
} catch {
  Write-LogLine "Failed: $($_.Exception.Message)"
  exit 1
}
