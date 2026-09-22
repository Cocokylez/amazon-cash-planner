@echo off
setlocal
cd /d "%~dp0"
call "%~dp0open-app.cmd" --no-browser %*
exit /b %errorlevel%
