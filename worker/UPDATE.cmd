@echo off
setlocal
cd /d "%~dp0"
call "%~dp0open-app.cmd" --update %*
exit /b %errorlevel%
