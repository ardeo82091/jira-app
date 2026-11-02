#Requires -Version 5.1
# Stops the background Jira App server (node ...\jira-app\server.js).
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $appDir 'server.js'
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($serverJs.ToLower()) }
if (-not $procs) { Write-Host 'Jira App is not running.'; return }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host "Stopped Jira App (PID $($p.ProcessId))."
}
