$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "start.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "AutoSocial Studio" -Action $action -Trigger $trigger -Settings $settings -Description "Starts AutoSocial Studio on localhost:3028 when the current user signs in." -Force | Out-Null
Write-Host "AutoSocial Studio will start when $env:USERNAME signs in." -ForegroundColor Green
