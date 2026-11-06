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

// View da carteira de clientes ("Reativar Clientes"). Arquivo À PARTE: só é
// aplicado quando o handshake diz que a empresa usa o recurso — ver
// motor/clientes.js e o cabeçalho do próprio .sql.
const SQL_CLIENTES_PATH = path.join(__dirname, '..', '..', '..', 'sql', 'views_clientes.sql');

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

/**
 * Aplica um arquivo .sql de views, comando a comando.
 *
 * Um comando que falha não aborta os outros; o resultado volta com os erros
 * do Firebird, para o /status mostrar a CAUSA e não o sintoma.
 *
 * @param {string} caminho
 * @param {string} rotulo   nome do arquivo para o log
 * @returns {Promise<{estado, aplicados, falhas, erros, em?}>}
 */
async function aplicarArquivoSql(caminho, rotulo = path.basename(caminho)) {
  if (!fs.existsSync(caminho)) {
    logWarn(`[ZapRun] ${caminho} não encontrado — nenhuma view aplicada.`);
    return {
      estado: 'arquivo-ausente',
      aplicados: 0,
      falhas: 0,
      erros: [`arquivo não encontrado: ${caminho}`]
    };
  }

  const comandos = separarComandos(fs.readFileSync(caminho, 'utf8'));
  if (comandos.length === 0) {
    logWarn(`[ZapRun] ${rotulo} está vazio — nenhuma view aplicada.`);
    return { estado: 'arquivo-vazio', aplicados: 0, falhas: 0, erros: [] };
  }

  logInfo(`[ZapRun] Aplicando ${comandos.length} comando(s) SQL de ${rotulo} no Firebird...`);

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
      // view faltando é a causa nº 1 de "não chega dado nenhum".
      logError(`[ZapRun] Falha ao aplicar SQL de ${rotulo} (${comando.slice(0, 80)}...):`, err);
    }
  }

  logInfo(`[ZapRun] ${rotulo}: ${aplicados} ok, ${falhas} com erro.`);
  return {
    estado: falhas === 0 ? 'ok' : 'com-erro',
    aplicados,
    falhas,
    erros,
    em: new Date().toISOString()
  };
}

async function runDatabaseMigrations() {
  ultimaAplicacao = await aplicarArquivoSql(SQL_PATH);
  return { aplicados: ultimaAplicacao.aplicados, falhas: ultimaAplicacao.falhas };
}

module.exports = {
  runDatabaseMigrations,
  aplicarArquivoSql,
  separarComandos,
  estadoDasViews,
  SQL_PATH,
  SQL_CLIENTES_PATH
};
