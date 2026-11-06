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
set "BAT_UPDATER=%BASE_DIR%\updater\run-updater.bat"
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
"%CAMINHO_NSSM%" install "%NOME_SERVICO%" "%CAMINHO_NODE%"
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar servico com NSSM.
    pause
    exit /b 1
)

if not exist "%PASTA_BACKEND%\logs" mkdir "%PASTA_BACKEND%\logs"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppDirectory "%PASTA_BACKEND%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppParameters "src\server.js"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" DisplayName "%NOME_SERVICO%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Description "ZapRun Orcamentos - envia os orcamentos do ERP para o ZapRun"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Start SERVICE_AUTO_START
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppStdout "%PASTA_BACKEND%\logs\service.log"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppStderr "%PASTA_BACKEND%\logs\service-error.log"

echo Iniciando servico...
net start "%NOME_SERVICO%"

echo.
echo ==================================================
echo CONFIGURANDO AGENDADOR: %NOME_TAREFA%
echo ==================================================
if exist "%BAT_UPDATER%" (
    rem Agendamento via schtasks universal (compativel com Windows 7, 8, 10, 11 e Server)
    echo Criando tarefa das %HORA_ATUALIZADOR_1%...
    schtasks /create /tn "%NOME_TAREFA%" /tr "\"%BAT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_1% /ru SYSTEM /f
    if !errorlevel! neq 0 (
        schtasks /create /tn "%NOME_TAREFA%" /tr "\"%BAT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_1% /f
    )
    echo Criando tarefa das %HORA_ATUALIZADOR_2%...
    schtasks /create /tn "%NOME_TAREFA%_19h" /tr "\"%BAT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_2% /ru SYSTEM /f
    if !errorlevel! neq 0 (
        schtasks /create /tn "%NOME_TAREFA%_19h" /tr "\"%BAT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_2% /f
    )
    echo Tarefas agendadas configuradas com sucesso (%HORA_ATUALIZADOR_1% e %HORA_ATUALIZADOR_2%).
) else if exist "%SCRIPT_UPDATER%" (
    schtasks /create /tn "%NOME_TAREFA%" /tr "\"%CAMINHO_NODE%\" \"%SCRIPT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_1% /ru SYSTEM /f
    schtasks /create /tn "%NOME_TAREFA%_19h" /tr "\"%CAMINHO_NODE%\" \"%SCRIPT_UPDATER%\"" /sc daily /st %HORA_ATUALIZADOR_2% /ru SYSTEM /f
    echo Tarefas agendadas configuradas com sucesso (%HORA_ATUALIZADOR_1% e %HORA_ATUALIZADOR_2%).
) else (
    echo [AVISO] Arquivo do updater nao encontrado em: %SCRIPT_UPDATER%
)

echo.
echo Operacao concluida!
pause
endlocal
