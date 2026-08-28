// Testes do estado local. Usa ZAPRUN_STATE_FILE para não tocar no estado real.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZAPRUN_STATE_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zaprun-state-')),
  'sync_state.json'
);

const {
  checkStateChanged,
  getLastSyncedAt,
  updateState,
  generateHash,
  snapshotState
} = require('./syncState');

const orcamento = (id, valor = 100) => ({
  externalId: id,
  erpCompanyId: 1,
  valorTotal: valor,
  itens: [{ codigo: 'A', quantidade: 1, raw: { QUALQUER: 'coisa' } }],
  raw: { LOG_TS: Date.now() }
});

test('empresa nunca sincronizada não tem lastSyncedAt', () => {
  assert.strictEqual(getLastSyncedAt(99), null);
});

test('a ordem das linhas não muda o hash', () => {
  // A view faz ORDER BY data e empata com frequência: sem ordenar por
  // externalId, o hash mudaria sozinho e o Motor reenviaria tudo todo ciclo.
  const a = [orcamento('1'), orcamento('2'), orcamento('3')];
  const b = [orcamento('3'), orcamento('1'), orcamento('2')];
  assert.strictEqual(generateHash(a), generateHash(b));
});

test('`raw` não entra no hash (colunas voláteis do ERP)', () => {
  const a = [{ ...orcamento('1'), raw: { LOG_TS: 1 } }];
  const b = [{ ...orcamento('1'), raw: { LOG_TS: 999999 } }];
  assert.strictEqual(generateHash(a), generateHash(b));
});

test('mudança real de valor muda o hash', () => {
  assert.notStrictEqual(
    generateHash([orcamento('1', 100)]),
    generateHash([orcamento('1', 200)])
  );
});

test('mudança em item muda o hash', () => {
  const base = orcamento('1');
  const alterado = { ...base, itens: [{ codigo: 'A', quantidade: 5 }] };
  assert.notStrictEqual(generateHash([base]), generateHash([alterado]));
});

test('ciclo completo: muda → grava → não muda mais', () => {
  const lista = [orcamento('1'), orcamento('2')];

  const primeiro = checkStateChanged(1, lista);
  assert.strictEqual(primeiro.changed, true);

  updateState(1, primeiro.hash);
  assert.ok(getLastSyncedAt(1));

  const segundo = checkStateChanged(1, lista);
  assert.strictEqual(segundo.changed, false);
  assert.strictEqual(segundo.hash, primeiro.hash);

  const terceiro = checkStateChanged(1, [...lista, orcamento('3')]);
  assert.strictEqual(terceiro.changed, true);
});

test('empresas têm estados independentes', () => {
  updateState(7, 'hash-sete');
  assert.strictEqual(snapshotState()['7'].hash, 'hash-sete');
  assert.notStrictEqual(snapshotState()['1']?.hash, 'hash-sete');
});

test('arquivo de estado corrompido é tratado como vazio, sem derrubar o serviço', () => {
  fs.writeFileSync(process.env.ZAPRUN_STATE_FILE, '{ isso não é json', 'utf8');
  assert.doesNotThrow(() => snapshotState());
  assert.deepStrictEqual(snapshotState(), {});
  // E o próximo ciclo reconstrói normalmente.
  assert.strictEqual(checkStateChanged(1, [orcamento('1')]).changed, true);
});
