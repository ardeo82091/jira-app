#Requires -Version 5.1
<#
  Downloads the Electron runtime used by the desktop app.
  "npm install" normally does this, but on networks where Node cannot reach GitHub
  (corporate proxy), this script downloads it through Windows' proxy settings and
  verifies the SHA-256 checksum published with the electron npm package.
#>
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgDir = Join-Path $appDir 'node_modules\electron'
if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) {
  Push-Location $appDir
  try { npm install --ignore-scripts } finally { Pop-Location }
}
$version = (Get-Content (Join-Path $pkgDir 'package.json') -Raw | ConvertFrom-Json).version
$name = "electron-v$version-win32-x64.zip"
$zip = Join-Path $env:TEMP $name
$url = "https://github.com/electron/electron/releases/download/v$version/$name"
Write-Host "Downloading $url ..."
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest $url -OutFile $zip -UseBasicParsing -TimeoutSec 900
$expected = (Get-Content (Join-Path $pkgDir 'checksums.json') -Raw | ConvertFrom-Json).$name
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) { Remove-Item $zip -Force; throw "Checksum mismatch for $name (expected $expected, got $actual)." }
$dist = Join-Path $pkgDir 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
Expand-Archive $zip -DestinationPath $dist -Force
Set-Content (Join-Path $pkgDir 'path.txt') 'electron.exe' -NoNewline
Remove-Item $zip -Force
Write-Host "Electron $version installed (checksum verified)." -ForegroundColor Green
