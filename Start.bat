@echo off
title Reverie
pushd "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Node.js is not installed or not on PATH.
  echo  Install LTS from https://nodejs.org then run this again.
  echo.
  pause
  popd
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo  npm was not found. Reinstall Node.js and ensure "Add to PATH" is checked.
  echo.
  pause
  popd
  exit /b 1
)

echo.
echo  Reverie
echo  -------
echo  Installing / updating dependencies...
call npm install --no-audit --no-fund --loglevel=error --no-progress
if errorlevel 1 (
  echo.
  echo  npm install failed.
  pause
  popd
  exit /b 1
)

echo.
echo  Starting app...
echo    UI:     http://127.0.0.1:5173
echo    Server: http://127.0.0.1:6969
echo.
echo  Keep this window open while you use Reverie.
echo  Close it ^(or Ctrl+C^) to stop.
echo.

REM Open the default browser as soon as the UI answers on 5173.
REM
REM The waiter runs from a generated .ps1 rather than an inline -Command: the old
REM caret-continued one-liner was parsed by cmd before PowerShell ever saw it, so
REM a single stray line break left the browser unopened. A script file has no
REM quoting or continuation to get wrong.
set "RV_WAIT=%TEMP%\reverie-open.ps1"
> "%RV_WAIT%" echo $ui = 'http://127.0.0.1:5173'
>>"%RV_WAIT%" echo $api = 'http://127.0.0.1:6969/api/health'
>>"%RV_WAIT%" echo $uiUp = $false
>>"%RV_WAIT%" echo for ($i = 0; $i -lt 90; $i++) {
>>"%RV_WAIT%" echo   try { $null = Invoke-WebRequest -Uri $ui -UseBasicParsing -TimeoutSec 2; $uiUp = $true } catch { $uiUp = $false }
>>"%RV_WAIT%" echo   if ($uiUp) {
>>"%RV_WAIT%" echo     try { $null = Invoke-WebRequest -Uri $api -UseBasicParsing -TimeoutSec 2; break } catch { }
>>"%RV_WAIT%" echo   }
>>"%RV_WAIT%" echo   Start-Sleep -Seconds 1
>>"%RV_WAIT%" echo }
>>"%RV_WAIT%" echo if ($uiUp) { Start-Process $ui }
>>"%RV_WAIT%" echo else { Write-Host 'Timed out waiting for the UI on 5173 - check the Reverie window for errors.'; Start-Sleep -Seconds 5 }
start "Reverie browser" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%RV_WAIT%"

call npm run dev
echo.
echo  Reverie stopped.
pause
popd
