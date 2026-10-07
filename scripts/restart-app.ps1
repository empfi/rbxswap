$ErrorActionPreference = 'SilentlyContinue'
# Stop any running instance of the app so the new build is loaded.
Get-Process | Where-Object { $_.ProcessName -match 'rblxswap|electron' -and $_.Path -match 'rblxswap' } | Stop-Process -Force
Start-Sleep -Milliseconds 800
# Launch the app detached so the terminal returns immediately.
Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
Write-Output 'App restarting...'
