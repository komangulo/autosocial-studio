$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "AutoSocial Studio" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "AutoSocial Studio autostart removed." -ForegroundColor Green
