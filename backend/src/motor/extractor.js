// motor/extractor.js
// Lê a view de orçamentos do Firebird do cliente e devolve os registros já no
// formato do payload da API.
//
// Fino de propósito: quem conhece o formato do ERP é motor/mapping.js. Aqui só
// existe "consultar a view com a janela de data e agrupar". Trocar de ERP não
// deve encostar neste arquivo.

const { query } = require('./firebird');
const { logInfo, logWarn } = require('../logger');
const { SQL_ORCAMENTOS, SQL_EMPRESAS, agruparOrcamentos, VIEW_ORCAMENTOS } = require('./mapping');

/**
 * Descobre quais IDEMPRESA existem na view do ERP.
 * Serve para diagnóstico à distância: se o token autoriza a empresa 1 e o ERP
 * só tem a 3, o log diz isso em vez de reportar "nenhum orçamento".
 *
 * @returns {Promise<number[]>}
 */
async function listarEmpresasDoErp() {
  const rows = await query(SQL_EMPRESAS, []);
  const ids = [];
  for (const row of rows) {
    const v = row.IDEMPRESA ?? row.idempresa;
    const n = Number(v);
    if (Number.isFinite(n)) ids.push(n);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Extrai os orçamentos emitidos a partir de `desde`.
 *
 * @param {string}        desde              data inicial "YYYY-MM-DD"
 * @param {number[]|null} empresasPermitidas IDEMPRESA que o token autoriza (null = todas)
 * @returns {Promise<{ orcamentos: Array<object>, linhas: number, descartadas: number, foraDoEscopo: number }>}
 */
async function extrairOrcamentos(desde, empresasPermitidas = null) {
  const rows = await query(SQL_ORCAMENTOS, [desde]);

  const { orcamentos, descartadas, foraDoEscopo } = agruparOrcamentos(
    rows,
    empresasPermitidas
  );

  // Descarte é anomalia da view (linha sem IDEMPRESA ou sem ID_ORCAMENTO), não
  // rotina. Precisa aparecer no log — é o único sinal de que a view está
  // devolvendo lixo, e ninguém tem RDP na máquina do cliente pra descobrir.
  if (descartadas > 0) {
    logWarn(
      `[ZapRun] ${descartadas} linha(s) de ${VIEW_ORCAMENTOS} sem IDEMPRESA ou ID_ORCAMENTO — descartadas. Verifique a view.`
    );
  }
  if (foraDoEscopo > 0) {
    logInfo(`[ZapRun] ${foraDoEscopo} linha(s) de empresa não autorizada pelo token — ignoradas.`);
  }

  return { orcamentos, linhas: rows.length, descartadas, foraDoEscopo };
}

module.exports = { extrairOrcamentos, listarEmpresasDoErp };
