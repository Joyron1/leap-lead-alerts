@echo off
rem Double-click to run the Snap Loans dashboard locally (Windows + WSL Ubuntu).
rem Keep this window open while you use the dashboard; closing it stops the local server.
rem Tip: right-click > Send to > Desktop (create shortcut) to launch it from the desktop.
title Snap Loans Dashboard - close this window to stop
cd /d %USERPROFILE%
start "" cmd /c "timeout /t 4 >nul & start http://localhost:5180"
wsl -d Ubuntu -e bash -lc "cd ~/projects/leap-lead-alerts/dashboard && ( [ -d node_modules ] || npm install ) && npx vite"
pause
