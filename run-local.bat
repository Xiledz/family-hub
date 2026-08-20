@echo off
REM Family Hub - local preview launcher.
REM Browsers block modular JavaScript on file:// URLs, so the app needs to be
REM served over http. This starts a tiny local web server in this folder.
setlocal
cd /d "%~dp0"
set PORT=8123

echo.
echo   Family Hub - starting local preview on http://localhost:%PORT%
echo   Leave this window open. Close it when you are done.
echo.

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/index.html
  python -m http.server %PORT%
  goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/index.html
  py -m http.server %PORT%
  goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/index.html
  npx --yes serve -l %PORT% .
  goto :eof
)

echo   Could not find Python or Node on this machine.
echo   Install either one, or just push to GitHub Pages and view it there.
echo.
pause
