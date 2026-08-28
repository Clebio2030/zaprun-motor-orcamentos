// Testes do fatiamento de lotes. Sem rede: só a função pura.

const test = require('node:test');
const assert = require('node:assert');

const { fatiarLote } = require('./sender');

const fake = (i, tamanhoTexto = 10) => ({
  externalId: String(i),
  descricao: 'x'.repeat(tamanhoTexto)
});

test('respeita o limite de quantidade', () => {
  const lotes = fatiarLote(Array.from({ length: 1200 }, (_, i) => fake(i)), 500);
  assert.deepStrictEqual(lotes.map(l => l.length), [500, 500, 200]);
});

test('lista vazia não gera lote', () => {
  assert.deepStrictEqual(fatiarLote([], 500), []);
  assert.deepStrictEqual(fatiarLote(null, 500), []);
});

test('corta por BYTES antes de atingir a contagem', () => {
  // 10 itens de ~1 KB com teto de 3 KB: a contagem (500) nunca seria atingida,
  // mas o teto de bytes tem que cortar — é isso que evita o 413 do ZapRun.
  const itens = Array.from({ length: 10 }, (_, i) => fake(i, 1000));
  const lotes = fatiarLote(itens, 500, 3000);

  assert.ok(lotes.length > 1, 'deveria ter cortado por bytes');
  for (const lote of lotes) {
    const bytes = Buffer.byteLength(JSON.stringify(lote), 'utf8');
    // Cada lote isolado precisa caber no teto (margem para os colchetes do array).
    assert.ok(bytes <= 3000 + 100, `lote com ${bytes} bytes passou do teto`);
  }
  assert.strictEqual(lotes.flat().length, 10, 'nenhum item pode se perder');
});

test('item maior que o teto vai sozinho, sem ser truncado', () => {
  // Cortar o item seria PERDER DADO. Melhor a API recusar um caso identificável
  // do que o Motor entregar um orçamento pela metade.
  const itens = [fake(1, 10), fake(2, 5000), fake(3, 10)];
  const lotes = fatiarLote(itens, 500, 1000);

  const loteDoGrande = lotes.find(l => l.some(i => i.externalId === '2'));
  assert.strictEqual(loteDoGrande.length, 1);
  assert.strictEqual(lotes.flat().length, 3);
});

test('chunkSize inválido cai no padrão em vez de gerar lote vazio', () => {
  // chunkSize 0 vindo de um handshake mal formado faria loop infinito de lotes
  // vazios se não houvesse o piso de 1.
  for (const ruim of [0, -5, NaN, undefined, null, 'abc']) {
    const lotes = fatiarLote(Array.from({ length: 3 }, (_, i) => fake(i)), ruim);
    assert.strictEqual(lotes.flat().length, 3, `chunkSize=${ruim} perdeu item`);
    assert.ok(lotes.every(l => l.length > 0), `chunkSize=${ruim} gerou lote vazio`);
  }
});

test('a ordem dos itens é preservada entre os lotes', () => {
  // A entrega é um stream ordenado: lote N+1 só sai depois do 200 em N. Se o
  // fatiamento embaralhasse, o `chunkInfo` deixaria de descrever a realidade.
  const itens = Array.from({ length: 25 }, (_, i) => fake(i));
  const lotes = fatiarLote(itens, 7);
  assert.deepStrictEqual(
    lotes.flat().map(i => i.externalId),
    itens.map(i => i.externalId)
  );
});
