@echo off
setlocal enabledelayedexpansion

title ZapRun Orcamentos - Adicionar Instancia
color 07

:: Verificacao de Administrador
net session >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERRO] Este script precisa ser executado como ADMINISTRADOR.
    pause
    exit /b
)

echo.
echo ##################################################
echo #                                                #
echo #   ZAPRUN ORCAMENTOS - NOVA INSTANCIA (BANCO)   #
echo #                                                #
echo ##################################################
echo.
echo Use este script para configurar um SEGUNDO banco de dados
echo nesta mesma maquina, rodando em uma pasta SEPARADA.
echo.

:: Detecta se o Node esta no PATH
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado no PATH. 
    echo Certifique-se de que o Node.js esta instalado.
    pause
    exit /b
)

:: 1. Definição do Nome da Instância
:ASK_NAME
set "INSTANCE_NAME="
set /p INSTANCE_NAME="Digite um NOME para esta instancia (ex: ZapRunOrcamentos_Filial) [Sem espacos]: "
if "!INSTANCE_NAME!"=="" (
    echo [ERRO] O nome nao pode ser vazio.
    goto ASK_NAME
)

:: 2. Definição da Porta
:ASK_PORT
set "INSTANCE_PORT="
set /p INSTANCE_PORT="Digite uma PORTA para esta instancia (padrao 3001 ja ocupado? Use 3002, 3003...): "
if "!INSTANCE_PORT!"=="" (
    echo [ERRO] A porta nao pode ser vazia.
    goto ASK_PORT
)

echo.
echo --- Configuracao do Banco de Dados ---
echo.

set "FB_HOST_IN="
set /p FB_HOST_IN="FB_HOST (IP SERVIDOR ) [Enter para 127.0.0.1]: "
if "!FB_HOST_IN!"=="" set "FB_HOST_IN=127.0.0.1"

set "FB_PORT_IN="
set /p FB_PORT_IN="FB_PORT (Porta do Firebird) [Enter para 3050]: "
if "!FB_PORT_IN!"=="" set "FB_PORT_IN=3050"

:ASK_DB
set "FB_DATABASE_IN="
set /p FB_DATABASE_IN="FB_DATABASE (Caminho completo do Banco .FDB): "
if "!FB_DATABASE_IN!"=="" (
    echo [ERRO] O caminho do banco e obrigatorio.
    goto ASK_DB
)

set "ZAPRUN_TOKEN_IN="
set /p ZAPRUN_TOKEN_IN="ZAPRUN_TOKEN (token de integracao deste banco, gerado no painel): "
if "!ZAPRUN_TOKEN_IN!"=="" (
    set "ZAPRUN_TOKEN_IN=EMPTY_VAL"
)

:: 3. Atualizar .env
echo.
echo Criando/Atualizando configuracoes de ambiente...
cd /d "%~dp0\backend"
node setup-env.js "!FB_HOST_IN!" "!FB_PORT_IN!" "!FB_DATABASE_IN!" "!ZAPRUN_TOKEN_IN!" "!INSTANCE_PORT!"

:: 3.1 Atualizar Config do Atualizador
echo.
echo Atualizando configuracoes do atualizador...
cd /d "%~dp0\updater"
node setup-updater.js "!INSTANCE_NAME!" "!INSTANCE_PORT!"

:: 4. Instalar Serviço
echo.
echo Instalando Servico Windows e Tarefa Agendada...
cd /d "%~dp0"
if exist "instalar_servico.bat" (
    call instalar_servico.bat "!INSTANCE_NAME!" "!INSTANCE_NAME!Updater"
) else (
    echo [ERRO] Arquivo instalar_servico.bat nao encontrado nesta pasta!
)

echo.
echo ##################################################
echo #   INSTANCIA !INSTANCE_NAME! CONFIGURADA!         #
echo #   Acesse em: http://localhost:!INSTANCE_PORT!   #
echo ##################################################
echo.
pause
endlocal
