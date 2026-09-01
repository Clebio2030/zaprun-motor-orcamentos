// motor/mapping.js
// ─────────────────────────────────────────────────────────────────────────────
//  ⚠️  ESTE É O ÚNICO ARQUIVO QUE MUDA QUANDO A VIEW DO ERP CHEGAR.
// ─────────────────────────────────────────────────────────────────────────────
//
// Ele traduz uma LINHA da view Firebird `ZAPRUN_ORCAMENTOS` no OBJETO que a API
// do ZapRun espera. Todo o resto do Motor (ciclo, lotes, retry, estado) é
// agnóstico ao formato do ERP — trocar de ERP é trocar a view + este arquivo.
//
// ── Contrato da view ────────────────────────────────────────────────────────
//
// A view pode entregar UMA linha por orçamento (sem itens) ou UMA linha por
// ITEM (o cabeçalho se repete). Os dois formatos funcionam: agruparOrcamentos()
// junta as linhas por (IDEMPRESA, ID_ORCAMENTO) e monta a lista de itens.
//
// Colunas OBRIGATÓRIAS:
//   IDEMPRESA      número da empresa dentro do ERP
//   ID_ORCAMENTO   chave do orçamento no ERP → vira `externalId` (idempotência)
//
// Colunas OPCIONAIS (ausência não quebra nada — o campo vai `null`):
//   NUMERO, DTEMISSAO, DTEMISSAO_TS, DTVALIDADE, SITUACAO
//   CLIENTE, CLIENTE_DOC, CLIENTE_FONE, CLIENTE_EMAIL
//   VENDEDOR_COD, VENDEDOR
//   VL_TOTAL, VL_DESCONTO, VL_LIQUIDO, VL_SUBTOTAL
//   ITEM_CODIGO, ITEM_DESCRICAO, ITEM_QTD, ITEM_VL_UNIT, ITEM_VL_TOTAL
//
// Toda coluna de TEXTO precisa sair da view como
//   CAST(campo AS VARCHAR(n) CHARACTER SET OCTETS)
// senão os acentos se perdem. Ver motor/encoding.js.
//
// Independente do mapeamento, a linha CRUA inteira vai no campo `raw` do
// payload e é gravada em JSONB no servidor. Nenhuma coluna que a view trouxer
// é perdida, mesmo sem mapeamento aqui.

const { readTextOrNull } = require('./encoding');

// Nome da view. Se sua view tiver outro nome, mude AQUI e em sql/views_zaprun.sql.
const VIEW_ORCAMENTOS = 'ZAPRUN_ORCAMENTOS';

// Coluna de data usada para a janela incremental (`WHERE col >= ?`).
const COLUNA_JANELA = 'DTEMISSAO';

// SELECT da janela. `?` = data inicial (YYYY-MM-DD).
// Só filtra por data: o recorte por empresa é feito por IDEMPRESA no ciclo,
// porque o token do ZapRun pode autorizar mais de uma empresa do mesmo ERP.
const SQL_ORCAMENTOS =
  `SELECT * FROM ${VIEW_ORCAMENTOS} WHERE ${COLUNA_JANELA} >= ? ORDER BY ${COLUNA_JANELA}`;

// SELECT das empresas presentes na view — usado no primeiro ciclo para o Motor
// saber quais IDEMPRESA existem no ERP e cruzar com o que o token autoriza.
const SQL_EMPRESAS =
  `SELECT DISTINCT IDEMPRESA FROM ${VIEW_ORCAMENTOS}`;

// ── Helpers de leitura ──────────────────────────────────────────────────────

/** Lê uma coluna tolerando MAIÚSCULA/minúscula. Ausente → undefined. */
function col(row, nome) {
  if (!row) return undefined;
  if (row[nome] !== undefined) return row[nome];
  return row[String(nome).toLowerCase()];
}

/** Número ou null. Aceita "1.234,56" e "1234.56". Nunca lança. */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // "1.234,56" (pt-BR) → "1234.56"
  const normalizado = /,\d{1,2}$/.test(s)
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/** Inteiro ou null. */
function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * Date do Firebird → ISO completo (com hora) ou null.
 *
 * Diferente de toDateOnly: aqui a hora IMPORTA, então mantemos o instante. O
 * driver devolve a data no fuso do processo (a máquina do cliente), e o ISO
 * carrega o offset — o servidor recebe o instante certo mesmo com fusos
 * diferentes.
 */
function toDataHora(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date do Firebird → "YYYY-MM-DD" (data local, sem deslocar por fuso) ou null. */
function toDateOnly(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // getFullYear/Month/Date (local) e não toISOString: o driver devolve a data
    // no fuso do processo, e o ISO em UTC jogaria 01/03 para 28/02 à noite.
    const a = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${a}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (s === '') return null;
  // Já vem "YYYY-MM-DD..." → corta no dia.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "DD/MM/YYYY"
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

/**
 * Converte a linha crua num objeto JSON-serializável, decodificando os Buffers
 * (OCTETS) para texto. É isto que vai no campo `raw` — precisa ser JSON puro,
 * senão o Buffer viraria `{"type":"Buffer","data":[...]}` no servidor.
 */
function rawSerializavel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (Buffer.isBuffer(v)) out[k] = readTextOrNull({ [k]: v }, k);
    else if (v instanceof Date) out[k] = Number.isNaN(v.getTime()) ? null : v.toISOString();
    else out[k] = v;
  }
  return out;
}

// ── Mapeamento ──────────────────────────────────────────────────────────────

/** Chave de agrupamento de uma linha. `null` se a linha não tem chave válida. */
function chaveDaLinha(row) {
  const idEmpresa = toInt(col(row, 'IDEMPRESA'));
  const externalId = readTextOrNull(row, 'ID_ORCAMENTO');
  if (idEmpresa === null || externalId === null) return null;
  return `${idEmpresa}::${externalId}`;
}

/** Cabeçalho do orçamento a partir de uma linha. */
function mapCabecalho(row) {
  return {
    externalId: readTextOrNull(row, 'ID_ORCAMENTO'),
    erpCompanyId: toInt(col(row, 'IDEMPRESA')),
    erpCompanyDoc: readTextOrNull(row, 'CGC') || readTextOrNull(row, 'CNPJ'),
    numero: readTextOrNull(row, 'NUMERO'),
    emitidoEm: toDateOnly(col(row, 'DTEMISSAO')),
    // Com hora: a régua de follow-up começa 3h após a emissão, e a data pura
    // não permite esse cálculo. Vai como ISO para não depender do fuso de quem
    // lê do outro lado.
    emitidoEmTs: toDataHora(col(row, 'DTEMISSAO_TS')) || toDataHora(col(row, 'DTEMISSAO')),
    validoAte: toDateOnly(col(row, 'DTVALIDADE')),
    situacao: readTextOrNull(row, 'SITUACAO'),
    cliente: {
      nome: readTextOrNull(row, 'CLIENTE'),
      documento: readTextOrNull(row, 'CLIENTE_DOC'),
      telefone: readTextOrNull(row, 'CLIENTE_FONE'),
      email: readTextOrNull(row, 'CLIENTE_EMAIL')
    },
    vendedor: {
      codigo: readTextOrNull(row, 'VENDEDOR_COD'),
      nome: readTextOrNull(row, 'VENDEDOR')
    },
    valorTotal: toNumber(col(row, 'VL_TOTAL')),
    desconto: toNumber(col(row, 'VL_DESCONTO')),
    valorLiquido: toNumber(col(row, 'VL_LIQUIDO')),
    subtotal: toNumber(col(row, 'VL_SUBTOTAL')),
    itens: [],
    raw: rawSerializavel(row)
  };
}

/**
 * Item a partir de uma linha, ou null quando a linha não carrega item.
 * Uma linha "tem item" se trouxer código OU descrição de item — só quantidade
 * ou só valor não bastam (seriam colunas de cabeçalho mal nomeadas).
 */
function mapItem(row) {
  const codigo = readTextOrNull(row, 'ITEM_CODIGO');
  const descricao = readTextOrNull(row, 'ITEM_DESCRICAO');
  if (codigo === null && descricao === null) return null;

  return {
    codigo,
    descricao,
    quantidade: toNumber(col(row, 'ITEM_QTD')),
    valorUnitario: toNumber(col(row, 'ITEM_VL_UNIT')),
    valorTotal: toNumber(col(row, 'ITEM_VL_TOTAL')),
    raw: rawSerializavel(row)
  };
}

/**
 * Linhas da view → lista de orçamentos prontos para o payload.
 *
 * Agrupa por (IDEMPRESA, ID_ORCAMENTO): a view pode repetir o cabeçalho em cada
 * item. O cabeçalho vem da PRIMEIRA linha do grupo; as demais só contribuem
 * itens. Linhas sem chave válida são devolvidas em `descartadas` — nunca
 * silenciosamente ignoradas ("a qualidade é o dado").
 *
 * @param {Array<object>} rows
 * @param {number[]|null} empresasPermitidas  IDEMPRESA que o token autoriza
 * @returns {{ orcamentos: Array<object>, descartadas: number, foraDoEscopo: number }}
 */
function agruparOrcamentos(rows, empresasPermitidas = null) {
  const porChave = new Map();
  let descartadas = 0;
  let foraDoEscopo = 0;

  const filtra = Array.isArray(empresasPermitidas) && empresasPermitidas.length > 0;
  const permitidas = filtra ? new Set(empresasPermitidas.map(Number)) : null;

  for (const row of rows || []) {
    const chave = chaveDaLinha(row);
    if (chave === null) { descartadas++; continue; }

    const idEmpresa = toInt(col(row, 'IDEMPRESA'));
    if (filtra && !permitidas.has(idEmpresa)) { foraDoEscopo++; continue; }

    let orcamento = porChave.get(chave);
    if (!orcamento) {
      orcamento = mapCabecalho(row);
      porChave.set(chave, orcamento);
    }

    const item = mapItem(row);
    if (item) orcamento.itens.push(item);
  }

  return { orcamentos: [...porChave.values()], descartadas, foraDoEscopo };
}

module.exports = {
  VIEW_ORCAMENTOS,
  COLUNA_JANELA,
  SQL_ORCAMENTOS,
  SQL_EMPRESAS,
  agruparOrcamentos,
  mapCabecalho,
  mapItem,
  chaveDaLinha,
  rawSerializavel,
  toNumber,
  toInt,
  toDateOnly,
  toDataHora
};
