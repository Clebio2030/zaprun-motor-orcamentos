@echo off
setlocal enabledelayedexpansion

title ZapRun Orcamentos - Desinstalador
color 07

rem --- CONFIGURACAO DINAMICA ---
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"
set "PASTA_BACKEND_LOCAL=%BASE_DIR%\backend"

set "CAMINHO_NSSM=%BASE_DIR%\nssm\win64\nssm.exe"
if not exist "%CAMINHO_NSSM%" (
    set "CAMINHO_NSSM=%BASE_DIR%\nssm\win32\nssm.exe"
)

if not exist "%CAMINHO_NSSM%" (
    color 0C
    echo [ERRO] Arquivo NSSM nao encontrado em: %BASE_DIR%\nssm\
    echo Certifique-se de ter copiado a pasta 'nssm' completa para esta pasta.
    pause
    exit /b
)

rem Nome do servico (Argumento %1)
set "NOME_SERVICO=%~1"

if "!NOME_SERVICO!"=="" (
    echo.
    echo ##################################################
    echo #        REMOVER SERVICO ZAPRUN ORCAMENTOS       #
    echo ##################################################
    echo.
    set /p NOME_SERVICO="Digite o NOME do servico que deseja remover [ou Enter para 'ZapRunOrcamentos']: "
)

if "!NOME_SERVICO!"=="" (set "NOME_SERVICO=ZapRunOrcamentos")

echo.
echo Verificando servico: !NOME_SERVICO!...

:: Tenta pegar o caminho onde o servico esta instalado
for /f "delims=" %%i in ('"%CAMINHO_NSSM%" get "!NOME_SERVICO!" AppDirectory 2^>nul') do set "APP_DIR_SERVICO=%%i"

if "!APP_DIR_SERVICO!"=="" (
    color 0E
    echo [AVISO] O servico '!NOME_SERVICO!' nao parece estar instalado.
    pause
    exit /b
)

:: Normaliza caminhos para comparacao (remove aspas e barras invertidas extras se houver)
set "DIR_LIMPO=!APP_DIR_SERVICO:"=!"
set "LOCAL_LIMPO=!PASTA_BACKEND_LOCAL:"=!"

echo.
echo Detalhes do Servico Encontrado:
echo --------------------------------------------------
echo Nome:      !NOME_SERVICO!
echo Pasta:     !DIR_LIMPO!
echo --------------------------------------------------
echo.

:: Verifica se a pasta do servico coincide com a pasta local
if /i "!DIR_LIMPO!"=="!LOCAL_LIMPO!" (
    color 0A
    echo [OK] O servico pertence a esta pasta. Proseguindo...
    color 07
) else (
    color 0C
    echo ##################################################
    echo #     ALERTA: ESTE SERVICO NAO E DESTA PASTA!    #
    echo ##################################################
    echo.
    echo O servico que voce quer apagar esta em: 
    echo "!DIR_LIMPO!"
    echo.
    echo Mas voce esta executando este script de:
    echo "!LOCAL_LIMPO!"
    echo.
    set /p CONFIRMA_EXTRA="Tem certeza que deseja apagar o servico de OUTRA pasta? (S/N): "
    if /i not "!CONFIRMA_EXTRA!"=="S" (
        echo Operacao cancelada para evitar acidentes.
        pause
        exit /b
    )
    color 07
)

set "NOME_TAREFA=!NOME_SERVICO!Updater"

echo.
echo Parando o servico !NOME_SERVICO!...
"%CAMINHO_NSSM%" stop "!NOME_SERVICO!" >nul 2>&1

echo Removendo o servico !NOME_SERVICO!...
"%CAMINHO_NSSM%" remove "!NOME_SERVICO!" confirm

echo Removendo tarefa agendada !NOME_TAREFA!...
schtasks /delete /f /tn "!NOME_TAREFA!" >nul 2>&1

echo.
echo Remocao concluida: !NOME_SERVICO!
echo.
pause
endlocal
