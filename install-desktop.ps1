#Requires -Version 5.1
<#
  Installs the floating desktop version of Jira App:
    - Desktop + Start Menu shortcuts ("Jira App")
    - Removes the old browser-mode auto-start shortcut (the desktop app starts with Windows itself;
      toggle it in the tray menu: "Start with Windows")
  Run:  powershell -ExecutionPolicy Bypass -File install-desktop.ps1
#>
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host 'Electron is not installed yet - installing...' -ForegroundColor Yellow
  & (Join-Path $appDir 'fetch-electron.ps1')
}

$shell = New-Object -ComObject WScript.Shell
function New-AppShortcut([string]$path) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $electron
  $lnk.Arguments = '"' + $appDir + '"'
  $lnk.WorkingDirectory = $appDir
  $lnk.Description = 'Jira App - floating Jira workspace (Ctrl+Shift+J)'
  $lnk.IconLocation = (Join-Path $appDir 'desktop\assets\icon.ico') + ',0'
  $lnk.Save()
  Write-Host "Created $path"
}
New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Jira App.lnk')
New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Jira App.lnk')

$oldStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Jira App.lnk'
if (Test-Path $oldStartup) { Remove-Item $oldStartup -Force; Write-Host 'Removed old browser-mode auto-start shortcut.' }

Write-Host ''
Write-Host 'Done. Double-click "Jira App" on your desktop.' -ForegroundColor Green
Write-Host 'It floats on top as a small widget, lives in the system tray, starts with Windows, and Ctrl+Shift+J shows/hides it.'
