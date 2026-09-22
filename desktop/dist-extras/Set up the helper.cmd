@echo off
setlocal enabledelayedexpansion
title Amazon Cash Planner - set up the helper
color 0F

rem  Finds the installed app and runs ITS setup, so nobody has to go looking
rem  inside Program Files for a batch file. Pass /check to only report where
rem  the app is, without installing anything.

set "CHECK="
if /i "%~1"=="/check" set "CHECK=1"

echo.
echo   ==========================================================
echo     Amazon Cash Planner  -  step 2 of 2
echo   ==========================================================
echo.
echo   This sets up the helper that downloads your Seller Central
echo   reports. It runs once. Everything stays on this computer.
echo.

rem ---------------------------------------------------------------
rem  Find the installed app. Per-user first, because that is where
rem  the installer puts it unless you chose otherwise.
rem ---------------------------------------------------------------
set "APP="

call :try "%LOCALAPPDATA%\Programs\Amazon Cash Planner"
if not defined APP call :try "%ProgramFiles%\Amazon Cash Planner"
if not defined APP call :try "%ProgramFiles(x86)%\Amazon Cash Planner"

rem The installer records where it went; used when someone chose their
rem own folder during installation.
if not defined APP (
  for /f "usebackq tokens=2,*" %%a in (
    `reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\c4e0b1ca-1e5e-5b4e-8a2a-amazon-cash-planner" /v InstallLocation 2^>nul ^| find "InstallLocation"`
  ) do call :try "%%b"
)

rem Last resort: ask Windows where the app was installed from its
rem uninstall entries, whatever the key happens to be called.
if not defined APP (
  for /f "usebackq delims=" %%k in (
    `reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "Amazon Cash Planner" 2^>nul ^| find "InstallLocation"`
  ) do (
    for /f "tokens=2,*" %%a in ("%%k") do call :try "%%b"
  )
)

if not defined APP goto notinstalled

echo   Found the app here:
echo       !APP!
echo.

if defined CHECK (
  echo   /check was used, so nothing was installed.
  exit /b 0
)

rem ---------------------------------------------------------------
rem  Hand over to the app's own setup and get out of the way.
rem
rem  No summary and no second pause here: SETUP.cmd already ends with
rem  its own result and waits for a key. Adding another would make
rem  someone read two endings and press a key twice to learn one
rem  thing.
rem ---------------------------------------------------------------
call "!APP!\resources\app\worker\SETUP.cmd"
exit /b !errorlevel!


:try
rem  Accept a folder only if the app's setup is actually inside it, so a
rem  leftover empty folder from an old install is never mistaken for one.
if defined APP exit /b 0
set "C=%~1"
if "%C%"=="" exit /b 0
if exist "%C%\resources\app\worker\SETUP.cmd" set "APP=%C%"
exit /b 0


:notinstalled
color 0E
echo   ----------------------------------------------------------
echo     Amazon Cash Planner is not installed yet.
echo   ----------------------------------------------------------
echo.
echo   Do step 1 first: run the installer in this same folder,
echo   the file whose name begins with
echo.
echo       Amazon Cash Planner Setup
echo.
echo   Then come back and run this file.
echo.
echo   Nothing was changed on this computer.
echo.
pause
exit /b 1
