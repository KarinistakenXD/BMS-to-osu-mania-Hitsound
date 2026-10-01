@echo off
setlocal
title BMS to osu!mania Hitsound

if not exist node_modules\ (
  echo [SETUP] Installing npm dependencies...
  call npm install
  if errorlevel 1 goto :error
)

echo [BUILD] Building renderer and Electron process...
call npm run build
if errorlevel 1 goto :error

echo [START] Launching BMS to osu!mania Hitsound...
call npx electron .
exit /b %errorlevel%

:error
echo.
echo Build or launch failed. See the error above.
pause
exit /b 1
