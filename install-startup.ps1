#Requires -Version 5.1
<#
  Creates two shortcuts that run Jira App in the background:
    - Startup folder  : starts automatically every time you log in to Windows
    - Desktop         : click to start / open the app at any time
  Undo with uninstall-startup.ps1
#>
param([switch]$NoDesktop)
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $appDir 'launch-hidden.vbs'
if (-not (Test-Path $launcher)) { throw "launch-hidden.vbs not found in $appDir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on PATH. Install it from https://nodejs.org first.' }

$shell = New-Object -ComObject WScript.Shell
function New-AppShortcut([string]$path) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + $launcher + '"'
  $lnk.WorkingDirectory = $appDir
  $lnk.Description = 'Jira App - local Jira workspace (http://127.0.0.1:4777)'
  $lnk.IconLocation = (Join-Path $env:WINDIR 'System32\shell32.dll') + ',13'
  $lnk.Save()
  Write-Host "Created $path"
}

$startup = [Environment]::GetFolderPath('Startup')
New-AppShortcut (Join-Path $startup 'Jira App.lnk')
if (-not $NoDesktop) {
  New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Jira App.lnk')
}
Write-Host 'Jira App will now start automatically when you log in to Windows.'
