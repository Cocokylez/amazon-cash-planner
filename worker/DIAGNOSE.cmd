@echo off
setlocal
title Amazon Cash Planner - Diagnose
color 0F
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     Amazon Cash Planner  -  diagnostic
echo   ==========================================================
echo.
echo   This writes a report describing what is installed and what
echo   is running. Your Amazon password, session cookies and the
echo   helper token are NOT included.
echo.

set "PY="
if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"
if not defined PY (
  where py >nul 2>&1 && set "PY=py -3"
)
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)

if not defined PY (
  echo   Python was not found at all, which is itself the answer:
  echo   the helper cannot run without it.
  echo.
  echo   Install it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

%PY% "%~dp0diagnose.py"

echo.
echo   ----------------------------------------------------------
echo   Send the file named above. It is plain text - open it first
echo   if you want to see exactly what it says.
echo   ----------------------------------------------------------
echo.
pause
