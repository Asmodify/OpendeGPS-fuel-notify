@echo off
rem Starts Fuel Tank Warner and opens the dashboard in the default browser.
rem Keep this window open while you want to be warned; close it (or press Ctrl+C) to stop.
cd /d "%~dp0"
title Fuel Tank Warner
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
set OPEN_BROWSER=1
node --no-warnings src/server.js
echo.
echo Fuel Tank Warner has stopped.
pause
