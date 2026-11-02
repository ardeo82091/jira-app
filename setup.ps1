#Requires -Version 5.1
<#
  One-time setup for Jira App.
    1. Asks for your Jira site, e-mail and API token.
    2. Stores the token ENCRYPTED with Windows DPAPI (only your Windows account on this laptop can read it).
    3. Tests the connection to Jira.
    4. Installs auto-start (Startup folder + Desktop shortcut) and starts the app.

  Run:  powershell -ExecutionPolicy Bypass -File setup.ps1
  Options: -NoStartup (skip auto-start), -NoLaunch (don't start the app now)
#>
param([switch]$NoStartup, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $appDir 'config.json'
$tokenUrl = 'https://id.atlassian.com/manage-profile/security/api-tokens'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not on PATH. Install it from https://nodejs.org first.' }

$existing = @{}
if (Test-Path $configPath) {
  $json = Get-Content $configPath -Raw | ConvertFrom-Json
  foreach ($p in $json.PSObject.Properties) { $existing[$p.Name] = $p.Value }
}

function Ask([string]$prompt, [string]$default) {
  $answer = Read-Host ("{0} [{1}]" -f $prompt, $default)
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}

Write-Host ''
Write-Host '=== Jira App setup ===' -ForegroundColor Cyan
$baseUrl = Ask 'Jira site URL' ($(if ($existing.baseUrl) { $existing.baseUrl } else { 'https://axismaxlife.atlassian.net' }))
$baseUrl = $baseUrl.TrimEnd('/')
$email = Ask 'Your Jira login e-mail' ($(if ($existing.email) { $existing.email } else { '' }))
if ($email -notmatch '^[^@\s]+@[^@\s]+$') { throw "'$email' is not a valid e-mail address." }

Write-Host ''
Write-Host "Create an API token at: $tokenUrl" -ForegroundColor Yellow
$open = Read-Host 'Open that page in your browser now? (Y/n)'
if ($open -notmatch '^[nN]') { Start-Process $tokenUrl }

$haveToken = [bool]$existing.apiTokenDpapi
$prompt = if ($haveToken) { 'Paste API token (input hidden; press Enter to keep the saved one)' } else { 'Paste API token (input hidden)' }
$secure = Read-Host $prompt -AsSecureString
if ($secure.Length -gt 0) {
  $tokenBlob = ConvertFrom-SecureString $secure    # DPAPI, current user only
} elseif ($haveToken) {
  $tokenBlob = $existing.apiTokenDpapi
} else {
  throw 'An API token is required.'
}

$config = [ordered]@{
  baseUrl            = $baseUrl
  email              = $email
  apiTokenDpapi      = $tokenBlob
  port               = $(if ($existing.port) { [int]$existing.port } else { 4777 })
  openBrowserOnStart = $(if ($null -ne $existing.openBrowserOnStart) { [bool]$existing.openBrowserOnStart } else { $true })
  defaultJql         = $(if ($existing.defaultJql) { $existing.defaultJql } else { 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' })
}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# Restrict config.json to the current Windows user.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $configPath /inheritance:r /grant:r "${me}:F" | Out-Null
Write-Host "Saved $configPath (token encrypted, file readable only by $me)." -ForegroundColor Green

Write-Host ''
Write-Host 'Testing connection to Jira...'
& node (Join-Path $appDir 'server.js') --check
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Connection test failed. Fix the problem above and run setup.ps1 again.' -ForegroundColor Red
  exit 1
}

$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $electron) {
  # Floating desktop app (preferred): shortcuts + it registers itself to start with Windows.
  if (-not $NoStartup) { & (Join-Path $appDir 'install-desktop.ps1') }
  if (-not $NoLaunch) {
    & (Join-Path $appDir 'stop-jira-app.ps1') | Out-Null
    Start-Process $electron -ArgumentList ('"' + $appDir + '"') -WorkingDirectory $appDir
    Write-Host 'Jira App is starting as a floating window (Ctrl+Shift+J shows/hides it).' -ForegroundColor Green
  }
  exit 0
}

if (-not $NoStartup) {
  $auto = Read-Host 'Start Jira App automatically when you log in to Windows? (Y/n)'
  if ($auto -notmatch '^[nN]') { & (Join-Path $appDir 'install-startup.ps1') }
}

if (-not $NoLaunch) {
  # Restart so a running instance picks up the new config.
  & (Join-Path $appDir 'stop-jira-app.ps1') | Out-Null
  Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $appDir 'launch-hidden.vbs') + '"')
  Write-Host ("Jira App is starting at http://127.0.0.1:{0}/ ..." -f $config.port) -ForegroundColor Green
}
