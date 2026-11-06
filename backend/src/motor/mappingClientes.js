// motor/mappingClientes.js
// ─────────────────────────────────────────────────────────────────────────────
//  Carteira de clientes ("Reativar Clientes") — o equivalente do mapping.js
//  para a view ZAPRUN_CLIENTES. Trocar de ERP = trocar sql/views_clientes.sql
//  + este arquivo; motor/clientes.js não conhece coluna nenhuma.
// ─────────────────────────────────────────────────────────────────────────────
//
// Contrato da view: UMA linha por cliente.
//
// Coluna OBRIGATÓRIA:
//   CDCLIENTE                 código do cliente no ERP → `externalId`
//
// Colunas OPCIONAIS (ausência vira null):
//   IDEMPRESA_CADASTRO, CLIENTE, RAZAO, CPFCNPJ, TELEFONE, CELULAR, TELEFONE2,
//   EMAIL, ENDERECO, NUMERO, BAIRRO, SUBBAIRRO, CIDADE, UF, CEP, DTCADASTRO,
//   DT_PRIMEIRA_COMPRA, DT_ULTIMA_COMPRA, TOTAL_PEDIDOS, VALOR_TOTAL_HISTORICO,
//   NRPEDIDO_ULTIMA_COMPRA, VALOR_ULTIMA_COMPRA, IDEMPRESA_ULTIMA_COMPRA,
//   NOME_EMPRESA_ULTIMA_COMPRA, CDVENDEDOR_ULTIMA_COMPRA, VENDEDOR_ULTIMA_COMPRA,
//   CDVENDEDOR_RESPONSAVEL, VENDEDOR_RESPONSAVEL, STATUS_CADASTRO
//
// NÃO há coluna de "dias sem comprar" nem de faixa: dependem da data de hoje,
// mudariam todo dia e quebrariam o envio incremental. O ZapRun calcula a faixa
// a partir de DT_ULTIMA_COMPRA. Ver o cabeçalho de sql/views_clientes.sql.

const { readTextOrNull } = require('./encoding');
const { toNumber, toInt, toDateOnly, rawSerializavel } = require('./mapping');

const VIEW_CLIENTES = 'ZAPRUN_CLIENTES';

// Sem janela de data: a carteira é lida inteira a cada ciclo (1 vez por dia).
// O recorte do que vai para a API é por hash de linha, em motor/clientes.js.
const SQL_CLIENTES = `SELECT * FROM ${VIEW_CLIENTES}`;

function col(row, nome) {
  if (!row) return undefined;
  if (row[nome] !== undefined) return row[nome];
  return row[String(nome).toLowerCase()];
}

/**
 * Uma linha da view → cliente do payload. `null` quando a linha não tem
 * CDCLIENTE (quem chama conta como descartada — nunca some em silêncio).
 */
function mapCliente(row) {
  const externalId = readTextOrNull(row, 'CDCLIENTE');
  if (externalId === null) return null;

  const status = readTextOrNull(row, 'STATUS_CADASTRO');

  return {
    externalId,
    erpCompanyId: toInt(col(row, 'IDEMPRESA_CADASTRO')),
    nome: readTextOrNull(row, 'CLIENTE'),
    razao: readTextOrNull(row, 'RAZAO'),
    documento: readTextOrNull(row, 'CPFCNPJ'),
    telefone: readTextOrNull(row, 'TELEFONE'),
    celular: readTextOrNull(row, 'CELULAR'),
    telefone2: readTextOrNull(row, 'TELEFONE2'),
    email: readTextOrNull(row, 'EMAIL'),
    endereco: {
      logradouro: readTextOrNull(row, 'ENDERECO'),
      numero: readTextOrNull(row, 'NUMERO'),
      bairro: readTextOrNull(row, 'BAIRRO'),
      subbairro: readTextOrNull(row, 'SUBBAIRRO'),
      cidade: readTextOrNull(row, 'CIDADE'),
      uf: readTextOrNull(row, 'UF'),
      cep: readTextOrNull(row, 'CEP')
    },
    cadastradoEm: toDateOnly(col(row, 'DTCADASTRO')),
    primeiraCompraEm: toDateOnly(col(row, 'DT_PRIMEIRA_COMPRA')),
    ultimaCompraEm: toDateOnly(col(row, 'DT_ULTIMA_COMPRA')),
    totalPedidos: toInt(col(row, 'TOTAL_PEDIDOS')) ?? 0,
    valorTotal: toNumber(col(row, 'VALOR_TOTAL_HISTORICO')),
    ultimoPedido: {
      numero: readTextOrNull(row, 'NRPEDIDO_ULTIMA_COMPRA'),
      valor: toNumber(col(row, 'VALOR_ULTIMA_COMPRA')),
      erpCompanyId: toInt(col(row, 'IDEMPRESA_ULTIMA_COMPRA')),
      loja: readTextOrNull(row, 'NOME_EMPRESA_ULTIMA_COMPRA'),
      vendedorCodigo: readTextOrNull(row, 'CDVENDEDOR_ULTIMA_COMPRA'),
      vendedorNome: readTextOrNull(row, 'VENDEDOR_ULTIMA_COMPRA')
    },
    vendedorResponsavel: {
      codigo: readTextOrNull(row, 'CDVENDEDOR_RESPONSAVEL'),
      nome: readTextOrNull(row, 'VENDEDOR_RESPONSAVEL')
    },
    // null = a view não disse; o servidor trata como ativo.
    inativoNoErp: status === null ? null : status.toUpperCase() === 'INATIVO',
    raw: rawSerializavel(row)
  };
}

/** Em que loja do ERP o cliente "mora", para o escopo do token. */
function empresaDoCliente(c) {
  return c.ultimoPedido?.erpCompanyId ?? c.erpCompanyId ?? null;
}

/**
 * Linhas da view → clientes, sem repetição.
 *
 * Repetido = o mesmo CDCLIENTE em duas linhas. Não deveria acontecer (a view
 * é uma linha por cliente), mas acontece se CLIENTE tiver uma linha por loja
 * com o mesmo código — e aí a view está errada para este ERP. Vence a última
 * linha, e a contagem vai para o log em vez de sumir.
 *
 * @param {Array<object>} rows
 * @param {number[]|null} empresasPermitidas  IDEMPRESA que o token autoriza
 * @returns {{ clientes, descartadas, repetidas, foraDoEscopo }}
 */
function agruparClientes(rows, empresasPermitidas = null) {
  const filtra = Array.isArray(empresasPermitidas) && empresasPermitidas.length > 0;
  const permitidas = filtra ? new Set(empresasPermitidas.map(Number)) : null;

  const porId = new Map();
  let descartadas = 0;
  let repetidas = 0;
  let foraDoEscopo = 0;

  for (const row of rows || []) {
    const cliente = mapCliente(row);
    if (!cliente) { descartadas++; continue; }

    if (filtra) {
      const empresa = empresaDoCliente(cliente);
      // Sem loja nenhuma, com token restrito: não há como provar que o cliente
      // é desta empresa — fica de fora, como o de outra loja.
      if (empresa === null || !permitidas.has(empresa)) { foraDoEscopo++; continue; }
    }

    if (porId.has(cliente.externalId)) repetidas++;
    porId.set(cliente.externalId, cliente);
  }

  return { clientes: [...porId.values()], descartadas, repetidas, foraDoEscopo };
}

module.exports = {
  VIEW_CLIENTES,
  SQL_CLIENTES,
  mapCliente,
  agruparClientes,
  empresaDoCliente
};
