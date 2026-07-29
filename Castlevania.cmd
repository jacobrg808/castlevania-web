@echo off
rem Double-click to play. Requires Node.js; run "npm run setup" once first.
cd /d "%~dp0"
call npm run play
if errorlevel 1 pause
