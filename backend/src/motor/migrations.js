// motor/migrations.js
// Aplica sql/views_zaprun.sql no Firebird do cliente, no boot do serviço.
//
// Por que pelo driver e não pelo isql.exe: o isql depende de instalação e PATH
// do Firebird na máquina do cliente, que varia. O driver já está no processo.
//
// É também assim que o updater propaga mudança de view: o release troca o .sql,
// o serviço reinicia e as views são reaplicadas. Por isso todo comando do
// arquivo precisa ser idempotente (`CREATE OR ALTER VIEW`).

const fs = require('fs');
const path = require('path');
const { query } = require('./firebird');
const { logInfo, logWarn, logError } = require('../logger');

const SQL_PATH = path.join(__dirname, '..', '..', '..', 'sql', 'views_zaprun.sql');

/**
 * Remove comentários de bloco e de linha e devolve os comandos separados.
 *
 * Não usa um parser de SQL de verdade porque o arquivo é nosso e tem forma
 * conhecida: uma sequência de CREATE OR ALTER VIEW. Se algum dia precisar de
 * PSQL (trigger/procedure com `;` interno), este split por `;` quebra — nesse
 * dia troque por blocos delimitados, não tente remendar a regex.
 */
function separarComandos(rawSql) {
  const limpo = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');

  return limpo
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Resultado da última aplicação das views, exposto em GET /status.
//
// Sem isto, "a view não subiu" só aparecia no arquivo de log da máquina do
// cliente — e o /status dizia apenas "Table unknown" no ciclo seguinte, que é
// a CONSEQUÊNCIA, não a causa. Quem diagnostica à distância precisa do erro
// do Firebird, não do sintoma.
let ultimaAplicacao = { estado: 'nao-executado', aplicados: 0, falhas: 0, erros: [] };

function estadoDasViews() {
  return ultimaAplicacao;
}

async function runDatabaseMigrations() {
  if (!fs.existsSync(SQL_PATH)) {
    logWarn(`[ZapRun] ${SQL_PATH} não encontrado — nenhuma view aplicada.`);
    ultimaAplicacao = {
      estado: 'arquivo-ausente',
      aplicados: 0,
      falhas: 0,
      erros: [`arquivo não encontrado: ${SQL_PATH}`]
    };
    return { aplicados: 0, falhas: 0 };
  }

  const comandos = separarComandos(fs.readFileSync(SQL_PATH, 'utf8'));
  if (comandos.length === 0) {
    logWarn('[ZapRun] views_zaprun.sql está vazio — nenhuma view aplicada.');
    ultimaAplicacao = { estado: 'arquivo-vazio', aplicados: 0, falhas: 0, erros: [] };
    return { aplicados: 0, falhas: 0 };
  }

  logInfo(`[ZapRun] Aplicando ${comandos.length} comando(s) SQL no Firebird...`);

  let aplicados = 0;
  let falhas = 0;
  const erros = [];

  for (const comando of comandos) {
    try {
      await query(comando);
      aplicados++;
    } catch (err) {
      erros.push({ sql: comando.slice(0, 120), erro: err.message });
      falhas++;
      // Um comando que falha não pode abortar os outros: uma view quebrada não
      // deve impedir as demais de subir. Mas o erro TEM que aparecer no log —
      // view faltando é a causa nº 1 de "não chega orçamento nenhum".
      logError(`[ZapRun] Falha ao aplicar SQL (${comando.slice(0, 80)}...):`, err);
    }
  }

  ultimaAplicacao = {
    estado: falhas === 0 ? 'ok' : 'com-erro',
    aplicados,
    falhas,
    erros,
    em: new Date().toISOString()
  };

  logInfo(`[ZapRun] Views aplicadas: ${aplicados} ok, ${falhas} com erro.`);
  return { aplicados, falhas };
}

module.exports = { runDatabaseMigrations, separarComandos, estadoDasViews, SQL_PATH };
