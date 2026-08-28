// Testes do mapeamento view → payload.
// Rodam sem Firebird e sem rede: `npm test` na pasta backend.

const test = require('node:test');
const assert = require('node:assert');

const {
  agruparOrcamentos,
  chaveDaLinha,
  rawSerializavel,
  toNumber,
  toInt,
  toDateOnly
} = require('./mapping');

// Helper: monta uma linha como o driver devolveria, com texto em Buffer WIN1252
// (é assim que a view entrega colunas CHARACTER SET OCTETS).
const win1252 = s => Buffer.from(s, 'latin1');

test('toNumber aceita número, ponto decimal e vírgula pt-BR', () => {
  assert.strictEqual(toNumber(12.5), 12.5);
  assert.strictEqual(toNumber('1234.56'), 1234.56);
  assert.strictEqual(toNumber('1.234,56'), 1234.56);
  assert.strictEqual(toNumber('1234,5'), 1234.5);
  assert.strictEqual(toNumber(''), null);
  assert.strictEqual(toNumber(null), null);
  assert.strictEqual(toNumber('abc'), null);
});

test('toInt trunca sem arredondar', () => {
  assert.strictEqual(toInt('7.9'), 7);
  assert.strictEqual(toInt(null), null);
});

test('toDateOnly não desloca a data por fuso horário', () => {
  // 1º de março às 00:00 local. Com toISOString viraria 28/02 em qualquer fuso
  // a oeste de Greenwich — foi por isso que o mapping usa getFullYear/Month/Date.
  const d = new Date(2026, 2, 1, 0, 0, 0);
  assert.strictEqual(toDateOnly(d), '2026-03-01');
  assert.strictEqual(toDateOnly('2026-03-01T10:00:00.000Z'), '2026-03-01');
  assert.strictEqual(toDateOnly('01/03/2026'), '2026-03-01');
  assert.strictEqual(toDateOnly(''), null);
  assert.strictEqual(toDateOnly(new Date('lixo')), null);
});

test('chaveDaLinha exige IDEMPRESA e ID_ORCAMENTO', () => {
  assert.strictEqual(chaveDaLinha({ IDEMPRESA: 1, ID_ORCAMENTO: win1252('99') }), '1::99');
  assert.strictEqual(chaveDaLinha({ IDEMPRESA: 1 }), null);
  assert.strictEqual(chaveDaLinha({ ID_ORCAMENTO: win1252('99') }), null);
  assert.strictEqual(chaveDaLinha({}), null);
});

test('colunas OCTETS têm o acento decodificado', () => {
  const linhas = [{
    IDEMPRESA: 1,
    ID_ORCAMENTO: win1252('100'),
    CLIENTE: win1252('CONSTRUÇÃO E MANUTENÇÃO LTDA'),
    VENDEDOR: win1252('JOSÉ ANTÔNIO')
  }];

  const { orcamentos } = agruparOrcamentos(linhas);
  assert.strictEqual(orcamentos[0].cliente.nome, 'CONSTRUÇÃO E MANUTENÇÃO LTDA');
  assert.strictEqual(orcamentos[0].vendedor.nome, 'JOSÉ ANTÔNIO');
});

test('linhas repetidas viram UM orçamento com vários itens', () => {
  const cabecalho = {
    IDEMPRESA: 1,
    ID_ORCAMENTO: win1252('100'),
    CLIENTE: win1252('ACME'),
    VL_TOTAL: '1.500,00'
  };
  const linhas = [
    { ...cabecalho, ITEM_CODIGO: win1252('A1'), ITEM_QTD: 2, ITEM_VL_UNIT: 500 },
    { ...cabecalho, ITEM_CODIGO: win1252('A2'), ITEM_QTD: 1, ITEM_VL_UNIT: 500 }
  ];

  const { orcamentos, descartadas } = agruparOrcamentos(linhas);
  assert.strictEqual(orcamentos.length, 1);
  assert.strictEqual(descartadas, 0);
  assert.strictEqual(orcamentos[0].itens.length, 2);
  assert.strictEqual(orcamentos[0].valorTotal, 1500);
  assert.deepStrictEqual(orcamentos[0].itens.map(i => i.codigo), ['A1', 'A2']);
});

test('view sem itens produz orçamento com lista de itens vazia', () => {
  const { orcamentos } = agruparOrcamentos([
    { IDEMPRESA: 1, ID_ORCAMENTO: win1252('100'), VL_TOTAL: 10 }
  ]);
  assert.strictEqual(orcamentos.length, 1);
  assert.deepStrictEqual(orcamentos[0].itens, []);
});

test('mesmo ID em empresas diferentes são orçamentos diferentes', () => {
  const { orcamentos } = agruparOrcamentos([
    { IDEMPRESA: 1, ID_ORCAMENTO: win1252('100') },
    { IDEMPRESA: 2, ID_ORCAMENTO: win1252('100') }
  ]);
  assert.strictEqual(orcamentos.length, 2);
});

test('linha sem chave é CONTADA, não sumida em silêncio', () => {
  const { orcamentos, descartadas } = agruparOrcamentos([
    { IDEMPRESA: 1, ID_ORCAMENTO: win1252('100') },
    { IDEMPRESA: 1 },                     // sem ID_ORCAMENTO
    { ID_ORCAMENTO: win1252('101') }      // sem IDEMPRESA
  ]);
  assert.strictEqual(orcamentos.length, 1);
  assert.strictEqual(descartadas, 2);
});

test('empresa fora do escopo do token é filtrada e contada', () => {
  const { orcamentos, foraDoEscopo } = agruparOrcamentos(
    [
      { IDEMPRESA: 1, ID_ORCAMENTO: win1252('100') },
      { IDEMPRESA: 9, ID_ORCAMENTO: win1252('900') }
    ],
    [1]
  );
  assert.strictEqual(orcamentos.length, 1);
  assert.strictEqual(orcamentos[0].erpCompanyId, 1);
  assert.strictEqual(foraDoEscopo, 1);
});

test('raw é JSON puro — Buffer vira texto, Date vira ISO', () => {
  const raw = rawSerializavel({
    NOME: win1252('SÃO PAULO'),
    QUANDO: new Date(Date.UTC(2026, 0, 15, 12, 0, 0)),
    NUM: 7,
    NADA: null
  });

  // Sem isto, um Buffer sairia como {"type":"Buffer","data":[...]} no servidor.
  assert.strictEqual(raw.NOME, 'SÃO PAULO');
  assert.strictEqual(raw.QUANDO, '2026-01-15T12:00:00.000Z');
  assert.strictEqual(raw.NUM, 7);
  assert.strictEqual(raw.NADA, null);
  assert.doesNotThrow(() => JSON.stringify(raw));
});

test('nomes de coluna em minúscula também funcionam', () => {
  // O driver roda com lowercase_keys, mas nem toda instalação se comporta igual.
  const { orcamentos } = agruparOrcamentos([
    { idempresa: 1, id_orcamento: win1252('100'), cliente: win1252('ACME') }
  ]);
  assert.strictEqual(orcamentos.length, 1);
  assert.strictEqual(orcamentos[0].cliente.nome, 'ACME');
});
