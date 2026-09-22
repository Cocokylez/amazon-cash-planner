@echo off
setlocal
cd /d "%~dp0"
"%~dp0venv\Scripts\python.exe" "%~dp0launch.py" %*
if not errorlevel 1 exit /b 0
echo Launch failed. Run SETUP.cmd or DIAGNOSE.cmd. See logs\launcher.log.
if not defined FBA_NONINTERACTIVE pause
exit /b 1
