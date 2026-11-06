// Testes da carteira de clientes (Reativar Clientes): mapeamento da view,
// estado por linha e envio em lotes. Sem Firebird e sem rede.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZAPRUN_CLIENTES_STATE_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zaprun-clientes-')),
  'clientes_state.json'
);

const { mapCliente, agruparClientes } = require('./mappingClientes');
const estado = require('./clientesState');
const { lerConfig, enviarLotes } = require('./clientes');
const { separarComandos } = require('./migrations');

// Linha como o node-firebird devolve: lowercase_keys e texto OCTETS em Buffer.
const win1252 = s => Buffer.from(s, 'latin1');
const linha = (cd, extra = {}) => ({
  cdcliente: cd,
  idempresa_cadastro: 1,
  cliente: win1252('JOSÉ DA CONCEIÇÃO'),
  celular: win1252('(21) 98765-4321'),
  telefone: null,
  dt_ultima_compra: new Date(2026, 6, 15, 0, 0, 0),
  dt_primeira_compra: new Date(2024, 0, 3, 0, 0, 0),
  total_pedidos: 7,
  valor_total_historico: '12345.67',
  nrpedido_ultima_compra: win1252('9981'),
  valor_ultima_compra: 870.5,
  idempresa_ultima_compra: 3,
  nome_empresa_ultima_compra: win1252('ZÉ GRANDE MIGUEL COUTO'),
  vendedor_ultima_compra: win1252('MÁRCIA'),
  status_cadastro: win1252('ATIVO'),
  ...extra
});

// ── mapeamento ───────────────────────────────────────────────────────────────

test('mapCliente decodifica WIN1252 e monta o payload', () => {
  const c = mapCliente(linha(42));
  assert.strictEqual(c.externalId, '42');
  assert.strictEqual(c.nome, 'JOSÉ DA CONCEIÇÃO');
  assert.strictEqual(c.celular, '(21) 98765-4321');
  assert.strictEqual(c.ultimaCompraEm, '2026-07-15');
  assert.strictEqual(c.primeiraCompraEm, '2024-01-03');
  assert.strictEqual(c.totalPedidos, 7);
  assert.strictEqual(c.valorTotal, 12345.67);
  assert.strictEqual(c.ultimoPedido.erpCompanyId, 3);
  assert.strictEqual(c.ultimoPedido.loja, 'ZÉ GRANDE MIGUEL COUTO');
  assert.strictEqual(c.ultimoPedido.vendedorNome, 'MÁRCIA');
  assert.strictEqual(c.inativoNoErp, false);
  const rawCli = c.raw.CLIENTE !== undefined ? c.raw.CLIENTE : c.raw.cliente;
  assert.strictEqual(rawCli, 'JOSÉ DA CONCEIÇÃO');
});

test('cliente que nunca comprou: datas nulas e zero pedidos', () => {
  const c = mapCliente(linha(7, {
    dt_ultima_compra: null,
    dt_primeira_compra: null,
    total_pedidos: 0,
    valor_total_historico: 0,
    idempresa_ultima_compra: null
  }));
  assert.strictEqual(c.ultimaCompraEm, null);
  assert.strictEqual(c.totalPedidos, 0);
  assert.strictEqual(c.ultimoPedido.erpCompanyId, null);
});

test('INATIVO no cadastro vira inativoNoErp=true', () => {
  assert.strictEqual(mapCliente(linha(1, { status_cadastro: win1252('INATIVO') })).inativoNoErp, true);
});

test('agruparClientes conta descartadas e repetidas em vez de sumir com elas', () => {
  const r = agruparClientes([linha(1), linha(2), linha(2), { cdcliente: null }]);
  assert.strictEqual(r.clientes.length, 2);
  assert.strictEqual(r.descartadas, 1);
  assert.strictEqual(r.repetidas, 1);
});

test('token restrito: fica só o cliente de loja autorizada', () => {
  const r = agruparClientes(
    [
      linha(1, { idempresa_ultima_compra: 3 }),
      linha(2, { idempresa_ultima_compra: 1 }),
      // nunca comprou: vale a loja do cadastro
      linha(3, { idempresa_ultima_compra: null, idempresa_cadastro: 3 }),
      // sem loja nenhuma: não dá para provar que é desta empresa
      linha(4, { idempresa_ultima_compra: null, idempresa_cadastro: null })
    ],
    [3]
  );
  assert.deepStrictEqual(r.clientes.map(c => c.externalId), ['1', '3']);
  assert.strictEqual(r.foraDoEscopo, 2);
});

// ── estado por linha ─────────────────────────────────────────────────────────

test('hash ignora o raw', () => {
  const a = mapCliente(linha(1));
  const b = { ...a, raw: { QUALQUER: Date.now() } };
  assert.strictEqual(estado.hashCliente(a), estado.hashCliente(b));
  assert.notStrictEqual(estado.hashCliente(a), estado.hashCliente({ ...a, totalPedidos: 8 }));
});

test('incremental manda só quem mudou; completo manda todos', () => {
  const clientes = [mapCliente(linha(1)), mapCliente(linha(2))];
  const state = { versao: 1, ultimoCompleto: null, ultimoEnvio: null, hashes: {} };
  const primeira = estado.calcularDiferenca(clientes, state, false);
  assert.strictEqual(primeira.enviar.length, 2);
  estado.registrarConfirmados(state, primeira.enviar, primeira.hashes);

  const mudou = [clientes[0], { ...clientes[1], totalPedidos: 99 }];
  const segunda = estado.calcularDiferenca(mudou, state, false);
  assert.deepStrictEqual(segunda.enviar.map(c => c.externalId), ['2']);

  assert.strictEqual(estado.calcularDiferenca(mudou, state, true).enviar.length, 2);
});

test('rejeitado perde o hash para ir de novo', () => {
  const clientes = [mapCliente(linha(1)), mapCliente(linha(2))];
  const state = { hashes: {} };
  const { hashes } = estado.calcularDiferenca(clientes, state, true);
  estado.registrarConfirmados(state, clientes, hashes, ['2']);
  assert.ok(state.hashes['1']);
  assert.strictEqual(state.hashes['2'], undefined);
});

test('precisaCompleto: nunca, vencido, ou pedido pelo servidor', () => {
  const agora = new Date('2026-11-10T10:00:00Z');
  assert.strictEqual(estado.precisaCompleto({ ultimoCompleto: null }, {}, agora), true);
  const s = { ultimoCompleto: '2026-11-08T10:00:00Z' };
  assert.strictEqual(estado.precisaCompleto(s, { fullACadaDias: 7 }, agora), false);
  assert.strictEqual(estado.precisaCompleto(s, { fullACadaDias: 2 }, agora), true);
  assert.strictEqual(estado.precisaCompleto(s, { fullACadaDias: 7, completoDesde: '2026-11-09T00:00:00Z' }, agora), true);
  assert.strictEqual(estado.precisaCompleto(s, { fullACadaDias: 7, completoDesde: '2026-11-01T00:00:00Z' }, agora), false);
});

test('podar esquece quem saiu da view', () => {
  const state = { hashes: { 1: 'a', 2: 'b' } };
  estado.podar(state, new Map([['1', 'a']]));
  assert.deepStrictEqual(Object.keys(state.hashes), ['1']);
});

// ── config do handshake ──────────────────────────────────────────────────────

test('sem bloco clientes no handshake = desligado (API antiga)', () => {
  assert.strictEqual(lerConfig({ ativo: true }).ativo, false);
  assert.strictEqual(lerConfig(null).ativo, false);
});

test('integração pausada desliga a carteira também', () => {
  assert.strictEqual(lerConfig({ ativo: false, clientes: { ativo: true } }).ativo, false);
  const cfg = lerConfig({ ativo: true, erpCompanyIds: [3], clientes: { ativo: true, cronExpr: '0 7 * * *' } });
  assert.strictEqual(cfg.ativo, true);
  assert.strictEqual(cfg.cronExpr, '0 7 * * *');
  assert.deepStrictEqual(cfg.erpCompanyIds, [3]);
});

// ── envio ────────────────────────────────────────────────────────────────────

const preparar = n => {
  const clientes = Array.from({ length: n }, (_, i) => mapCliente(linha(i + 1)));
  const state = { hashes: {} };
  const { enviar, hashes } = estado.calcularDiferenca(clientes, state, true);
  return { enviar, hashes, state };
};

test('cada lote confirmado grava os hashes dele; falha no meio preserva os anteriores', async () => {
  const { enviar, hashes, state } = preparar(5);
  let chamada = 0;
  const postar = async payload => {
    chamada++;
    if (chamada === 2) return { ok: false, erro: 'HTTP 500' };
    return { ok: true, persisted: { received: payload.clientes.length, rejected: [] } };
  };
  const r = await enviarLotes({ enviar, hashes, state, chunkSize: 2, modo: 'full', totalCarteira: 5, postar, salvar: () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.confirmados, 2);
  assert.deepStrictEqual(Object.keys(state.hashes).sort(), ['1', '2']);
});

test('contagem que não bate aborta sem gravar o lote', async () => {
  const { enviar, hashes, state } = preparar(3);
  const postar = async () => ({ ok: true, persisted: { received: 1, rejected: [] } });
  const r = await enviarLotes({ enviar, hashes, state, chunkSize: 10, modo: 'full', totalCarteira: 3, postar, salvar: () => {} });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(state.hashes, {});
});

test('rejeitado não aborta: o resto do lote é confirmado', async () => {
  const { enviar, hashes, state } = preparar(3);
  const postar = async () => ({ ok: true, persisted: { received: 2, rejected: ['2'], motivos: ['sem nome'] } });
  const r = await enviarLotes({ enviar, hashes, state, chunkSize: 10, modo: 'full', totalCarteira: 3, postar, salvar: () => {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rejeitados, 1);
  assert.deepStrictEqual(Object.keys(state.hashes).sort(), ['1', '3']);
});

test('payload leva snapshotId estável, expectedTotal e chunkInfo', async () => {
  const { enviar, hashes, state } = preparar(3);
  const vistos = [];
  const postar = async p => {
    vistos.push(p);
    return { ok: true, persisted: { received: p.clientes.length } };
  };
  await enviarLotes({ enviar, hashes, state, chunkSize: 2, modo: 'incremental', totalCarteira: 3, postar, salvar: () => {} });
  assert.strictEqual(vistos.length, 2);
  assert.strictEqual(vistos[0].snapshotId, vistos[1].snapshotId);
  assert.strictEqual(vistos[0].expectedTotal, 3);
  assert.deepStrictEqual(vistos[1].chunkInfo, { atual: 2, total: 2 });
  assert.strictEqual(vistos[0].syncMode, 'incremental');
});

// ── a view ───────────────────────────────────────────────────────────────────

test('views_clientes.sql vira UM comando (nenhum ";" no corpo)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sql', 'views_clientes.sql'), 'utf8');
  const comandos = separarComandos(sql);
  assert.strictEqual(comandos.length, 1);
  assert.match(comandos[0], /^CREATE OR ALTER VIEW ZAPRUN_CLIENTES/);
  // Nenhuma coluna volátil (dependente de CURRENT_DATE) na view do Motor.
  assert.doesNotMatch(comandos[0], /CURRENT_DATE/);
});

test('views_clientes.sql: as duas partes do UNION têm o mesmo número de colunas', () => {
  const sql = separarComandos(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sql', 'views_clientes.sql'), 'utf8')
  )[0];
  const declaradas = sql.slice(sql.indexOf('(') + 1, sql.indexOf(') AS')).split(',').length;
  const partes = sql.split(/UNION ALL/);
  // Parte 1: o SELECT principal vem depois das CTEs (o último). Parte 2: o
  // primeiro (o último é o subselect do NOT EXISTS).
  const contar = (parte, inicio) => {
    const corpo = parte.slice(inicio, parte.indexOf('FROM', inicio));
    // vírgulas de topo (fora de parênteses)
    let nivel = 0;
    let n = 1;
    for (const ch of corpo) {
      if (ch === '(') nivel++;
      else if (ch === ')') nivel--;
      else if (ch === ',' && nivel === 0) n++;
    }
    return n;
  };
  assert.strictEqual(partes.length, 2);
  assert.strictEqual(contar(partes[0], partes[0].lastIndexOf('SELECT')), declaradas);
  assert.strictEqual(contar(partes[1], partes[1].indexOf('SELECT')), declaradas);
});
