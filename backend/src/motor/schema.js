// motor/schema.js
// Lê o schema REAL do ERP do cliente: quais colunas cada tabela tem, e de que
// tipo.
//
// Existe por um motivo específico. A view é escrita a partir do que o cliente
// descreve, mas o Firebird recusa a criação inteira no PRIMEIRO nome errado —
// então descobrir cinco colunas erradas custava cinco idas e vindas com alguém
// na frente da máquina do cliente. Com isto, uma requisição devolve tudo.
//
// Só LEITURA de catálogo (RDB$), nunca de dado do cliente: nenhum nome, valor
// ou telefone sai por aqui.

const { query } = require('./firebird');

// Tabelas que a view de orçamentos usa. Serve de padrão quando ninguém pede
// tabela específica.
const TABELAS_PADRAO = ['ORCAMENTO', 'ORCPROD', 'VENDEDOR', 'CONFIGURACAO', 'CLIENTE'];

// RDB$FIELD_TYPE → nome legível. É o que responde perguntas como "STATUS é
// número ou texto?", que decide se o CASE da view usa 0 ou '0'.
const TIPOS = {
  7: 'SMALLINT',
  8: 'INTEGER',
  10: 'FLOAT',
  12: 'DATE',
  13: 'TIME',
  14: 'CHAR',
  16: 'BIGINT',
  27: 'DOUBLE',
  35: 'TIMESTAMP',
  37: 'VARCHAR',
  261: 'BLOB'
};

/**
 * @param {string[]} tabelas
 * @returns {Promise<Record<string, Array<{coluna, tipo, tamanho, nulo}>>>}
 */
async function lerColunas(tabelas = TABELAS_PADRAO) {
  const alvo = (tabelas.length ? tabelas : TABELAS_PADRAO)
    .map(t => String(t).trim().toUpperCase())
    .filter(t => /^[A-Z0-9_$]+$/.test(t)); // nada de SQL vindo de fora

  if (!alvo.length) return {};

  // Uma consulta só para todas as tabelas. O IN é montado com placeholders,
  // não por concatenação — e os nomes já passaram pelo filtro acima.
  const marcas = alvo.map(() => '?').join(',');
  const sql = `
    SELECT TRIM(rf.RDB$RELATION_NAME) AS TABELA,
           TRIM(rf.RDB$FIELD_NAME)    AS COLUNA,
           f.RDB$FIELD_TYPE           AS TIPO,
           f.RDB$FIELD_LENGTH         AS TAMANHO,
           f.RDB$FIELD_SUB_TYPE       AS SUBTIPO,
           rf.RDB$NULL_FLAG           AS NAO_NULO
      FROM RDB$RELATION_FIELDS rf
      JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
     WHERE TRIM(rf.RDB$RELATION_NAME) IN (${marcas})
     ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`;

  const rows = await query(sql, alvo);

  const saida = {};
  for (const t of alvo) saida[t] = [];

  for (const r of rows) {
    const tabela = String(r.TABELA ?? r.tabela ?? '').trim();
    if (!saida[tabela]) saida[tabela] = [];

    const tipoNum = Number(r.TIPO ?? r.tipo);
    // Subtipo 1/2 em SMALLINT/INTEGER/BIGINT indica NUMERIC/DECIMAL — um
    // "INTEGER" cru e um NUMERIC(15,2) pedem tratamento diferente na view.
    const sub = Number(r.SUBTIPO ?? r.subtipo ?? 0);
    const tipo = TIPOS[tipoNum] || `tipo-${tipoNum}`;

    saida[tabela].push({
      coluna: String(r.COLUNA ?? r.coluna ?? '').trim(),
      tipo: sub === 1 ? `NUMERIC(${tipo})` : sub === 2 ? `DECIMAL(${tipo})` : tipo,
      tamanho: Number(r.TAMANHO ?? r.tamanho) || null,
      obrigatorio: Boolean(r.NAO_NULO ?? r.nao_nulo)
    });
  }

  // Tabela pedida que não existe volta como array vazio — isso É a resposta
  // ("essa tabela não existe neste ERP"), e não um erro.
  return saida;
}

module.exports = { lerColunas, TABELAS_PADRAO };
