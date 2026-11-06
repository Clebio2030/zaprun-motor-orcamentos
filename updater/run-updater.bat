@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set "NODE_EXE=%%i"
)
if exist "%NODE_EXE%" (
    "%NODE_EXE%" "%~dp0updater.js"
) else (
    node "%~dp0updater.js"
)
endlocal
