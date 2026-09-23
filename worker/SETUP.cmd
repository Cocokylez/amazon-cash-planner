@echo off
setlocal enabledelayedexpansion
title Amazon Cash Planner - Setup
color 0F

echo.
echo   ==========================================================
echo     Amazon Cash Planner  -  one-time setup
echo   ==========================================================
echo.
echo   This installs a small helper on THIS computer so the app
echo   can download your Seller Central reports.
echo.
echo   Nothing is purchased. No account is created. Everything
echo   stays on this computer.
echo.

cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  1. Find a usable Python
rem ---------------------------------------------------------------
echo   [1/3] Looking for Python...

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)

if not defined PY goto missingpython

rem Confirm it actually runs and is new enough (3.10+).
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 goto oldpython

for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])"') do set "PYVER=%%v"
echo         found Python !PYVER!
echo.

rem ---------------------------------------------------------------
rem  2. Install
rem ---------------------------------------------------------------
echo   [2/3] Installing (this downloads a browser - a few minutes)...
echo.
%PY% "%~dp0install.py"
if errorlevel 1 goto installfailed

rem ---------------------------------------------------------------
rem  3. Desktop shortcut
rem ---------------------------------------------------------------
echo.
echo   [3/3] Creating a desktop shortcut...
%PY% "%~dp0make_shortcut.py"
if errorlevel 1 goto noshortcut

echo.
echo   ==========================================================
echo     Done.
echo   ==========================================================
echo.
echo   Look on your Desktop for:  Amazon Cash Planner
echo   Double-click it. It starts the helper and opens the app.
echo.
echo   The helper also starts by itself next time you log in.
echo.
pause
exit /b 0


:noshortcut
color 0E
echo.
echo   ==========================================================
echo     Installed - but no Desktop shortcut
echo   ==========================================================
echo.
echo   Everything else worked. The shortcut could not be created;
echo   the message above says why.
echo.
echo   To open the app, double-click this file instead:
echo       %~dp0open-app.cmd
echo.
echo   You can right-click that file and choose "Send to" then
echo   "Desktop (create shortcut)" to put it where you want it.
echo.
pause
exit /b 0


:missingpython
color 0E
echo.
echo   ----------------------------------------------------------
echo     Python is not installed on this computer.
echo   ----------------------------------------------------------
echo.
echo   The helper is a small Python program, so Python is needed
echo   once. It is free and takes about two minutes.
echo.
echo   1. Go to:   https://www.python.org/downloads/
echo   2. Click the big yellow "Download Python" button.
echo   3. Run the installer.
echo   4. IMPORTANT: tick "Add python.exe to PATH" on the first
echo      screen, before clicking Install Now.
echo   5. When it finishes, come back and double-click this
echo      SETUP file again.
echo.
echo   Opening the download page for you now...
start "" "https://www.python.org/downloads/"
echo.
pause
exit /b 1


:oldpython
color 0E
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>nul') do set "PYVER=%%v"
echo.
echo   ----------------------------------------------------------
echo     Your Python is too old  (found !PYVER!, need 3.10+)
echo   ----------------------------------------------------------
echo.
echo   Install a current version from:
echo       https://www.python.org/downloads/
echo   Tick "Add python.exe to PATH" during installation, then
echo   run this SETUP file again.
echo.
start "" "https://www.python.org/downloads/"
pause
exit /b 1


:installfailed
color 0C
echo.
echo   ----------------------------------------------------------
echo     Setup did not finish.
echo   ----------------------------------------------------------
echo.
echo   The messages above say what went wrong. The two common
echo   causes are:
echo     - no internet connection while downloading the browser
echo     - antivirus blocking the download
echo.
echo   Nothing was damaged. You can run this SETUP file again.
echo.
pause
exit /b 1
