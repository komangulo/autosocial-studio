$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

$braveCandidates = @()
$braveCommand = Get-Command "brave.exe" -ErrorAction SilentlyContinue
if ($braveCommand) { $braveCandidates += $braveCommand.Source }
if ($env:LOCALAPPDATA) { $braveCandidates += Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\Application\brave.exe" }
if ($env:ProgramFiles) { $braveCandidates += Join-Path $env:ProgramFiles "BraveSoftware\Brave-Browser\Application\brave.exe" }
if (${env:ProgramFiles(x86)}) { $braveCandidates += Join-Path ${env:ProgramFiles(x86)} "BraveSoftware\Brave-Browser\Application\brave.exe" }
$bravePath = $braveCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

$dashboardUrl = "http://localhost:3028"
Start-Job -ArgumentList $bravePath, $dashboardUrl -ScriptBlock {
  param($browserPath, $url)
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 | Out-Null; break }
    catch { Start-Sleep -Seconds 1 }
  }
  if ($browserPath) { Start-Process -FilePath $browserPath -ArgumentList "--new-tab", $url }
  else { Start-Process $url }
} | Out-Null

npm start
