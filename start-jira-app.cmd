@echo off
rem Starts Jira App in this console window (Ctrl+C to stop). Opens http://127.0.0.1:4777/
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed or not on PATH. Install it from https://nodejs.org & pause & exit /b 1)
node server.js %*
if errorlevel 1 pause
