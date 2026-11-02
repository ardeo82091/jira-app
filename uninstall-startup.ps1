#Requires -Version 5.1
# Removes the Startup and Desktop shortcuts and stops the running app. Your config.json is kept.
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($folder in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('Desktop'))) {
  $lnk = Join-Path $folder 'Jira App.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
}
& (Join-Path $appDir 'stop-jira-app.ps1')
Write-Host 'Jira App will no longer start automatically.'
