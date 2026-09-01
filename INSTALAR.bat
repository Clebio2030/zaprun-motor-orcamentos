@echo off
setlocal enabledelayedexpansion
title ZapRun Orcamentos - Instalador
color 07

:: ==================================================
:: VERIFICACAO DE ADMINISTRADOR
:: ==================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ##################################################
    echo #      ERRO: PRIVILEGIOS INSUFICIENTES           #
    echo ##################################################
    echo.
    echo O instalador precisa ser executado como ADMINISTRADOR!
    echo.
    echo Clique com o botao direito no arquivo e escolha:
    echo "Executar como administrador"
    echo.
    pause
    exit /b
)

powershell -Command "$Host.UI.RawUI.FontSize = 14; $Host.UI.RawUI.WindowSize = New-Object System.Management.Automation.Host.Size(120, 40)" >nul 2>&1
mode con: cols=120 lines=40 >nul 2>&1

color 0A
echo.
echo ##################################################
echo #                                                #
echo #     ZAPRUN ORCAMENTOS - INSTALADOR             #
echo #                                                #
echo ##################################################
echo.
color 07

cd /d "%~dp0"

:: ==================================================
:: [PASSO 1/5] NODE.JS
:: ==================================================
if not exist "node.msi" goto SKIP_NODE

color 0A
echo --------------------------------------------------
echo [PASSO 1/5] Instalacao do Node.js
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Encontrado instalador do Node.js (node.msi).
echo Complete a instalacao na janela que se abriu.
echo.
echo AGUARDANDO TERMINO DA INSTALACAO...

start /wait msiexec /i node.msi

echo.
echo Instalacao do Node.js concluida (ou cancelada pelo usuario).

:: Recarrega o PATH do registro: o CMD nao rele o PATH depois que o MSI instala,
:: e sem isto o 'npm' do passo seguinte nao seria reconhecido.
echo Atualizando PATH da sessao...
for /f "delims=" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"Path\",\"Machine\")"') do set "SYSPATH=%%i"
for /f "delims=" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"Path\",\"User\")"') do set "USRPATH=%%i"
set "PATH=!SYSPATH!;!USRPATH!;%PATH%"

goto CHECK_NPM

:SKIP_NODE
echo [AVISO] 'node.msi' nao encontrado na pasta atual. Pulando o Node.js...

:CHECK_NPM
:: ==================================================
:: [PASSO 2/5] DEPENDENCIAS
:: ==================================================
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 2/5] Instalando dependencias do Motor
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
call npm -v >nul 2>&1
if %errorlevel% EQU 0 goto INSTALL_DEPS

color 0E
echo.
echo [ATENCAO] O comando 'npm' nao foi reconhecido.
echo Se voce acabou de instalar o Node.js, feche este script e
echo abra novamente como Administrador.
echo.
echo Pressione qualquer tecla para tentar continuar mesmo assim...
pause >nul
color 07

:INSTALL_DEPS
if not exist "backend" goto ERROR_NO_BACKEND

cd backend
echo Executando 'npm install' (pode levar alguns minutos)...

call npm install

if %errorlevel% NEQ 0 goto ERROR_INSTALL

echo.
echo [SUCESSO] Dependencias instaladas!

:: ==================================================
:: [PASSO 3/5] AMBIENTE (.env)
:: ==================================================
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 3/5] Configuracao do ambiente (.env)
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Informe os dados de conexao. Deixe em branco para MANTER o valor atual.
echo.

set "FB_HOST_IN="
set /p FB_HOST_IN="FB_HOST (IP do servidor Firebird) [Enter para manter]: "

set "FB_PORT_IN="
set /p FB_PORT_IN="FB_PORT (porta do Firebird, normalmente 3050) [Enter para manter]: "

set "FB_DATABASE_IN="
set /p FB_DATABASE_IN="FB_DATABASE (caminho do banco, o mesmo do Start.in) [Enter para manter]: "

echo.
echo O TOKEN e gerado no painel do ZapRun, em Integracoes ^> ERP.
echo Ele comeca com "zrerp_" e diz de qual empresa sao os orcamentos.
echo.
set "ZAPRUN_TOKEN_IN="
set /p ZAPRUN_TOKEN_IN="ZAPRUN_TOKEN (token de integracao) [Enter para manter]: "

if "!FB_HOST_IN!"=="" (set "ARG1=EMPTY_VAL") else (set "ARG1=!FB_HOST_IN!")
if "!FB_PORT_IN!"=="" (set "ARG2=EMPTY_VAL") else (set "ARG2=!FB_PORT_IN!")
if "!FB_DATABASE_IN!"=="" (set "ARG3=EMPTY_VAL") else (set "ARG3=!FB_DATABASE_IN!")
if "!ZAPRUN_TOKEN_IN!"=="" (set "ARG4=EMPTY_VAL") else (set "ARG4=!ZAPRUN_TOKEN_IN!")

echo.
echo Atualizando .env...

if exist "setup-env.js" (
    node setup-env.js "!ARG1!" "!ARG2!" "!ARG3!" "!ARG4!"
) else (
    color 0C
    echo [ERRO] setup-env.js nao encontrado na pasta backend.
    color 07
)

echo.
echo [SUCESSO] Ambiente configurado!

echo.
echo Configurando o atualizador automatico...
cd /d "%~dp0\updater"
node setup-updater.js "ZapRunOrcamentos" "3001"
cd /d "%~dp0"

:: ==================================================
:: [PASSO 4/5] FIREBIRD (firebird.conf)
:: ==================================================
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 4/5] Configuracao do Firebird (firebird.conf)
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Precisamos do caminho da instalacao do Firebird (onde fica o firebird.conf).
echo.
echo Exemplo: C:\Program Files\Firebird\Firebird_5_0
echo.

:ASK_FB_PATH
set "FB_PATH="
set /p FB_PATH="Digite o caminho COMPLETO da pasta do Firebird: "

:: O Explorer do Windows, em "Copiar como caminho", coloca ASPAS em volta.
:: Coladas aqui, elas viravam ""C:\...."\firebird.conf" e o teste falhava
:: sempre, mesmo com o caminho certo.
set "FB_PATH=!FB_PATH:"=!"

:: Barra no fim geraria "C:\pasta\\firebird.conf".
if "!FB_PATH:~-1!"=="\" set "FB_PATH=!FB_PATH:~0,-1!"

if "!FB_PATH!"=="" (
    echo.
    echo [ERRO] O caminho nao pode ficar vazio.
    goto ASK_FB_PATH
)

echo.
echo Verificando: "!FB_PATH!\firebird.conf"...

if not exist "!FB_PATH!\firebird.conf" (
    color 0C
    echo.
    echo ##################################################
    echo #  ERRO: FIREBIRD.CONF NAO ENCONTRADO            #
    echo ##################################################
    echo.
    echo Caminho invalido: !FB_PATH!
    echo Abra o Disco C:, ache onde o Firebird foi instalado, copie o
    echo caminho da barra de enderecos e cole aqui com o botao direito.
    echo.
    pause
    color 07
    echo.
    goto ASK_FB_PATH
)

echo.
echo Arquivo encontrado! Fazendo backup e aplicando as alteracoes...

set PS_SCRIPT=%TEMP%\zaprun_firebird_%RANDOM%.ps1
(
echo $path = '!FB_PATH!\firebird.conf'
echo $bkp = $path + '.bak'
echo Copy-Item $path $bkp -Force
echo Write-Host 'Backup criado em: ' $bkp
echo $lines = Get-Content $path
echo $newLines = New-Object System.Collections.Generic.List[string]
echo $modified = $false
echo foreach ($line in $lines^) {
echo   $trimmed = $line.TrimStart^(^)
echo   if ($trimmed -match '^\s*#?\s*AuthServer\s*='^) {
echo     $line = 'AuthServer = Srp256, Srp, Legacy_Auth'
echo     Write-Host 'Configurado: AuthServer = Srp256, Srp, Legacy_Auth'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#?\s*AuthClient\s*='^) {
echo     $line = 'AuthClient = Srp256, Srp, Legacy_Auth'
echo     Write-Host 'Configurado: AuthClient = Srp256, Srp, Legacy_Auth'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#?\s*WireCrypt\s*='^) {
echo     $line = 'WireCrypt = Enabled'
echo     Write-Host 'Configurado: WireCrypt = Enabled'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#\s*RemoteServicePort\s*='^) {
echo     $line = $line -replace '^\s*#\s*', ''
echo     Write-Host 'Descomentado: RemoteServicePort'
echo     $modified = $true
echo   }
echo   $newLines.Add($line^)
echo }
echo if ($modified^) {
echo   [System.IO.File]::WriteAllLines($path, $newLines, [System.Text.Encoding]::Default^)
echo   Write-Host 'Arquivo atualizado com sucesso!'
echo } else {
echo   Write-Host 'Nenhuma alteracao necessaria.'
echo }
) > "%PS_SCRIPT%"

powershell -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
del "%PS_SCRIPT%" >nul 2>&1

echo.
echo [SUCESSO] Firebird configurado.
echo.
echo --------------------------------------------------
echo REINICIAR O SERVICO DO FIREBIRD
echo --------------------------------------------------
echo.
set /p RESTART_FB="Reiniciar o servico do Firebird automaticamente? (S/N): "
if /i "!RESTART_FB!"=="S" (
    echo.
    echo Identificando servico do Firebird...

    powershell -Command ^
        "$svc = Get-Service | Where-Object { $_.DisplayName -like '*Firebird*' -or $_.Name -like '*Firebird*' };" ^
        "if ($svc) {" ^
        "  foreach ($s in $svc) {" ^
        "    Write-Host 'Reiniciando servico encontrado:' $s.Name;" ^
        "    Restart-Service -Name $s.Name -Force;" ^
        "    Write-Host 'Servico' $s.Name 'reiniciado com sucesso.';" ^
        "  }" ^
        "} else {" ^
        "  Write-Host 'Nenhum servico do Firebird encontrado automaticamente.';" ^
        "  Write-Host 'Reinicie manualmente pelo services.msc';" ^
        "}"
)

:: ==================================================
:: [PASSO 5/5] SERVICO WINDOWS
:: ==================================================
:: Nao existe passo de "criar views" aqui: o proprio Motor aplica
:: sql/views_zaprun.sql no Firebird a cada boot do servico, pelo driver do Node
:: (backend/src/motor/migrations.js). Isso dispensa o isql.exe, que depende de
:: instalacao e PATH do Firebird e falhava em parte das maquinas.
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 5/5] Instalacao do servico do Windows
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
if exist "instalar_servico.bat" (
    call instalar_servico.bat
) else (
    color 0C
    echo [ERRO] 'instalar_servico.bat' nao encontrado!
    color 07
)

goto VERIFICAR

:: ==================================================
:: VERIFICACAO FINAL
:: ==================================================
:VERIFICAR
color 0A
echo.
echo --------------------------------------------------
echo VERIFICACAO
echo --------------------------------------------------
color 07
echo.
echo Aguardando o servico subir...
timeout /t 8 >nul

echo.
echo Consultando http://127.0.0.1:3001/status ...
echo.
powershell -NoProfile -Command ^
    "try {" ^
    "  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/status' -TimeoutSec 20;" ^
    "  Write-Host '  Versao do Motor : ' $r.sourceVersion;" ^
    "  Write-Host '  Firebird        : ' $r.firebird;" ^
    "  Write-Host '  Token           : ' $r.token;" ^
    "  Write-Host '  API             : ' $r.apiUrl;" ^
    "  if ($r.firebird -ne 'ok') { Write-Host ''; Write-Host '  [ATENCAO] Sem conexao com o Firebird - confira FB_DATABASE no backend\.env.' -ForegroundColor Yellow }" ^
    "} catch {" ^
    "  Write-Host '  [ATENCAO] O Motor nao respondeu. Confira o servico ZapRunOrcamentos no services.msc' -ForegroundColor Yellow;" ^
    "  Write-Host '  e os logs em backend\logs\.' -ForegroundColor Yellow" ^
    "}"

goto FIM

:ERROR_INSTALL
color 0C
echo.
echo ##################################################
echo #         ERRO NA INSTALACAO DAS DEPENDENCIAS    #
echo ##################################################
echo.
cd /d "%~dp0"
goto FIM

:ERROR_NO_BACKEND
color 0C
echo.
echo ##################################################
echo #      ERRO: PASTA 'BACKEND' NAO ENCONTRADA      #
echo ##################################################
echo.
goto FIM

:FIM
echo.
color 0A
echo ==================================================
echo               INSTALACAO FINALIZADA
echo ==================================================
color 07
echo.
echo O Motor roda sozinho de hora em hora, das 08h as 22h.
echo Para forcar um envio agora, abra no navegador da maquina:
echo    http://127.0.0.1:3001/status
echo.
echo Logs: backend\logs\zaprun-AAAA-MM-DD.log
echo.
echo Pressione qualquer tecla para sair...
pause >nul
endlocal
