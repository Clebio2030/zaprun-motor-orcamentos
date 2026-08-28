@echo off
setlocal

rem --- CONFIGURACAO DINAMICA ---
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

rem Nome do servico no Windows
if "%~1"=="" (set "NOME_SERVICO=ZapRunOrcamentos") else (set "NOME_SERVICO=%~1")
if "%~2"=="" (set "NOME_TAREFA=%NOME_SERVICO%Updater") else (set "NOME_TAREFA=%~2")

rem Caminho do node.js
set "CAMINHO_NODE=C:\Program Files\nodejs\node.exe"
if not exist "%CAMINHO_NODE%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set "CAMINHO_NODE=%%i"
)

if not exist "%CAMINHO_NODE%" (
    echo [ERRO] Node.exe nao encontrado em %CAMINHO_NODE% ou no PATH.
    pause
    exit /b 1
)

rem Pasta do projeto e backend
set "PASTA_PROJETO=%BASE_DIR%"
set "PASTA_BACKEND=%BASE_DIR%\backend"
set "SCRIPT_BACKEND=src\server.js"
set "SCRIPT_UPDATER=%BASE_DIR%\updater\updater.js"
rem Horarios de checagem de update (manha e fim de tarde)
set "HORA_ATUALIZADOR_1=08:00"
set "HORA_ATUALIZADOR_2=19:00"

rem Caminho do NSSM
set "CAMINHO_NSSM=%BASE_DIR%\nssm\win64\nssm.exe"
if not exist "%CAMINHO_NSSM%" (
    set "CAMINHO_NSSM=%BASE_DIR%\nssm\win32\nssm.exe"
)

if not exist "%CAMINHO_NSSM%" (
    echo [ERRO] NSSM nao encontrado em: %BASE_DIR%\nssm\
    echo Certifique-se de ter copiado a pasta 'nssm' completa.
    pause
    exit /b 1
)

echo.
echo ==================================================
echo INSTALANDO SERVICO: %NOME_SERVICO%
echo PASTA: %PASTA_PROJETO%
echo ==================================================
echo.

echo Parando/Removendo versao anterior se existir...
"%CAMINHO_NSSM%" stop "%NOME_SERVICO%" >nul 2>&1
"%CAMINHO_NSSM%" remove "%NOME_SERVICO%" confirm >nul 2>&1

echo Registrando no Windows...
"%CAMINHO_NSSM%" install "%NOME_SERVICO%" "%CAMINHO_NODE%" "%PASTA_BACKEND%\%SCRIPT_BACKEND%"
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar servico com NSSM.
    pause
    exit /b 1
)

"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppDirectory "%PASTA_BACKEND%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" DisplayName "%NOME_SERVICO%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Description "ZapRun Orcamentos - envia os orcamentos do ERP para o ZapRun"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Start SERVICE_AUTO_START

echo Iniciando servico...
net start "%NOME_SERVICO%"

echo.
echo ==================================================
echo CONFIGURANDO AGENDADOR: %NOME_TAREFA%
echo ==================================================
if exist "%SCRIPT_UPDATER%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$action   = New-ScheduledTaskAction -Execute '\"%CAMINHO_NODE%\"' -Argument '\"%SCRIPT_UPDATER%\"';" ^
        "$triggers = @((New-ScheduledTaskTrigger -Daily -At '%HORA_ATUALIZADOR_1%'), (New-ScheduledTaskTrigger -Daily -At '%HORA_ATUALIZADOR_2%'));" ^
        "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
        "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;" ^
        "Register-ScheduledTask -TaskName '%NOME_TAREFA%' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null;" ^
        "Write-Host 'Tarefa agendada criada com sucesso (08:00 e 19:00).'"
) else (
    echo [AVISO] Arquivo do updater nao encontrado em: %SCRIPT_UPDATER%
)

echo.
echo Operacao concluida!
pause
endlocal
