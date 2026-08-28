// src/ensureUpdaterSchedule.js
//
// Garante, a cada inicializacao do servico, que a tarefa agendada do updater
// exista com os horarios desejados (08:00 e 19:00).
//
// Por que isso vive no backend (e nao no updater.js ou no .bat)?
//   - A pasta `updater/` esta em preservePaths: o updater.js NUNCA e atualizado
//     nos clientes, entao mudar horario la nao chega em quem ja esta instalado.
//   - O `instalar_servico.bat` so roda em instalacao manual.
//   - O backend ESTA em managedPaths e e reiniciado a cada update. Logo, ele e a
//     unica peca que (a) chega no cliente via update e (b) roda sozinho.
// Assim, ao publicar uma release, todo cliente que passar pelo ciclo das 19:00
// recebe o novo backend, reinicia e passa a ter tambem a checagem das 08:00 —
// sem nenhuma intervencao manual nas maquinas dos clientes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { logInfo, logError } = require('./logger');

// Horarios de checagem de update (formato HH:mm, 24h).
const HORARIOS = ['08:00', '19:00'];

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const UPDATER_DIR = path.join(ROOT_DIR, 'updater');
const UPDATER_SCRIPT = path.join(UPDATER_DIR, 'updater.js');
const UPDATER_CONFIG = path.join(UPDATER_DIR, 'updater-config.json');

function readServiceName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(UPDATER_CONFIG, 'utf8').replace(/^﻿/, ''));
    return cfg.serviceName || 'ZapRunOrcamentos';
  } catch (err) {
    return 'ZapRunOrcamentos';
  }
}

function findNodeExe() {
  // process.execPath e o node.exe que esta rodando o servico — caminho confiavel.
  if (process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  const fallback = 'C:\\Program Files\\nodejs\\node.exe';
  return fs.existsSync(fallback) ? fallback : 'node.exe';
}

function buildPowerShellScript(taskName, nodeExe, updaterScript) {
  // Primeiro VERIFICA se a tarefa ja tem exatamente os horarios desejados.
  // Se ja tiver, nao mexe (imprime SKIP) — evita re-registrar a cada boot e
  // preservar o historico de execucao da tarefa. So (re)registra quando falta
  // ou esta diferente, replicando principal/settings do instalar_servico.bat.
  const triggers = HORARIOS
    .map((h) => `(New-ScheduledTaskTrigger -Daily -At '${h}')`)
    .join(', ');
  const wantArray = HORARIOS.map((h) => `'${h}'`).join(', ');

  return [
    `$ErrorActionPreference = 'Stop';`,
    `$want = (@(${wantArray}) | Sort-Object -Unique) -join ',';`,
    `$task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue;`,
    `if ($task) {`,
    `  $have = @($task.Triggers | ForEach-Object { try { ([datetime]$_.StartBoundary).ToString('HH:mm') } catch { $null } } | Where-Object { $_ });`,
    `  if ((($have | Sort-Object -Unique) -join ',') -eq $want) { Write-Output 'SKIP'; return; }`,
    `}`,
    `$action    = New-ScheduledTaskAction -Execute '"${nodeExe}"' -Argument '"${updaterScript}"';`,
    `$triggers  = @(${triggers});`,
    `$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;`,
    `$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;`,
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null;`,
    `Write-Output 'SET';`
  ].join(' ');
}

function ensureUpdaterSchedule() {
  if (process.platform !== 'win32') {
    return; // Agendador via schtasks/PowerShell so existe no Windows.
  }

  if (!fs.existsSync(UPDATER_SCRIPT)) {
    logError(`[Schedule] updater.js nao encontrado em ${UPDATER_SCRIPT}; pulando agendamento.`);
    return;
  }

  const taskName = `${readServiceName()}Updater`;
  const nodeExe = findNodeExe();
  const script = buildPowerShellScript(taskName, nodeExe, UPDATER_SCRIPT);

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  );

  if (result.status === 0) {
    const acao = /SKIP/.test(result.stdout || '') ? 'ja estava correta' : 'registrada/atualizada';
    logInfo(`[Schedule] Tarefa '${taskName}' ${acao} (horarios: ${HORARIOS.join(', ')}).`);
  } else {
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
    logError(`[Schedule] Falha ao garantir tarefa '${taskName}': ${out || 'erro desconhecido'}`);
  }
}

module.exports = { ensureUpdaterSchedule };
