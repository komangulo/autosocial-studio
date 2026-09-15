$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$nodeVersion = (& node -p "Number(process.versions.node.split('.')[0])" 2>$null)
if (-not $nodeVersion -or [int]$nodeVersion -lt 18) {
  throw "Node.js 18 or newer is required. Install it from https://nodejs.org/ and run this script again."
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

npm ci
npm run build:studio
npx playwright install chromium

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "FFmpeg and ffprobe must be available in PATH for video validation and processing."
Write-Host "Run scripts\start.ps1. The dashboard will open at http://localhost:3028 in Brave or your default browser."
