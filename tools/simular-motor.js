#!/usr/bin/env node
//
// Simulador do Motor — fala com a API do ZapRun sem ERP, sem Firebird e sem
// máquina Windows.
//
// Para que serve, na prática:
//   • conferir que um token novo funciona, antes de mandar o implantador viajar
//   • provar que a idempotência está de pé depois de mexer no servidor
//   • reproduzir um problema de um cliente sem acessar a máquina dele
//
// Uso:
//   ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js
//   ZAPRUN_TOKEN=zrerp_xxx ZAPRUN_API_URL=https://dev.zaprun.com.br node tools/simular-motor.js
//
// Os orçamentos criados usam o prefixo SIM- para você identificar e apagar
// depois. Ele NÃO apaga nada sozinho: apagar dado de um servidor de verdade a
// partir de um script de teste é como se perde dado de cliente por engano.

const TOKEN = process.env.ZAPRUN_TOKEN || '';
const API = (process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br').replace(/\/+$/, '');
const ERP_COMPANY_ID = Number(process.env.SIM_ERP_COMPANY_ID || 1);

if (!TOKEN) {
  console.error('\nFalta o token.\n');
  console.error('  ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js\n');
  console.error('Gere um no painel do ZapRun em Integracoes > ERP.\n');
  process.exit(1);
}

let falhas = 0;

function checar(nome, ok, detalhe = '') {
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nome}${detalhe ? ` ${detalhe}` : ''}`);
  if (!ok) falhas++;
}

async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  const res = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'X-Integration-Token': TOKEN
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body };
}

// Um orçamento com a mesma forma que o mapping.js produz a partir da view.
const orcamento = (id, extra = {}) => ({
  externalId: id,
  erpCompanyId: ERP_COMPANY_ID,
  numero: id,
  emitidoEm: new Date().toISOString().slice(0, 10),
  situacao: 'ABERTO',
  cliente: {
    nome: 'CLIENTE DE TESTE — CONSTRUÇÃO SÃO JOSÉ',
    documento: '12.345.678/0001-90',
    telefone: '(11) 99999-8888'
  },
  vendedor: { codigo: '7', nome: 'JOSÉ ANTÔNIO' },
  valorTotal: 1500,
  valorLiquido: 1500,
  itens: [
    { codigo: 'A1', descricao: 'CIMENTO CP-II 50KG', quantidade: 10, valorUnitario: 35.5, valorTotal: 355 },
    { codigo: 'A2', descricao: 'AREIA MÉDIA M³', quantidade: 3, valorUnitario: 120, valorTotal: 360 }
  ],
  raw: { ORIGEM: 'simular-motor.js' },
  ...extra
});

async function main() {
  console.log(`\nSimulador do Motor → ${API}`);
  console.log(`Token: ${TOKEN.slice(0, 12)}...\n`);

  // ── 1. Handshake ───────────────────────────────────────────────────────────
  console.log('1. Handshake');
  const hs = await chamar('/erp/handshake');

  if (hs.status === 401) {
    console.error('\n  Token inválido ou revogado. Gere outro no painel.\n');
    process.exit(1);
  }

  checar('responde 200', hs.status === 200, `status ${hs.status}`);
  checar('integração ativa', hs.body?.ativo === true, hs.body?.ativo === false ? '(pausada no painel)' : '');
  console.log(`       empresa: ${hs.body?.empresa?.nome} (id ${hs.body?.empresa?.id})`);
  console.log(`       lote: ${hs.body?.chunkSize} · janela: ${hs.body?.janelaDias}d · inicial: ${hs.body?.janelaInicialDias}d`);
  console.log(`       cron: ${hs.body?.cronExpr}`);
  console.log(`       empresas do ERP autorizadas: ${JSON.stringify(hs.body?.erpCompanyIds) || 'todas'}`);

  if (hs.body?.ativo !== true) {
    console.error('\n  Integração pausada — o resto do teste não se aplica.\n');
    process.exit(1);
  }

  const marca = Date.now().toString().slice(-6);
  const ids = [`SIM-${marca}-A`, `SIM-${marca}-B`, `SIM-${marca}-C`];

  // ── 2. Primeira entrega ────────────────────────────────────────────────────
  console.log('\n2. Primeira entrega (3 orçamentos novos)');
  const envio1 = await chamar('/erp/orcamentos/sync', {
    metodo: 'POST',
    corpo: {
      sourceVersion: 'simulador',
      dataReferencia: new Date().toISOString().slice(0, 10),
      syncMode: 'full',
      snapshotId: `sim-${marca}`,
      expectedTotal: 3,
      chunkInfo: { atual: 1, total: 1 },
      orcamentos: ids.map(id => orcamento(id))
    }
  });
  checar('responde 200', envio1.status === 200, `status ${envio1.status}`);
  checar('3 recebidos', envio1.body?.persisted?.received === 3, JSON.stringify(envio1.body?.persisted));
  checar('3 novos', envio1.body?.persisted?.inserted === 3);

  // ── 3. Idempotência ────────────────────────────────────────────────────────
  console.log('\n3. Reenvio idêntico — não pode duplicar');
  const envio2 = await chamar('/erp/orcamentos/sync', {
    metodo: 'POST',
    corpo: { orcamentos: ids.map(id => orcamento(id)) }
  });
  checar('0 novos', envio2.body?.persisted?.inserted === 0, JSON.stringify(envio2.body?.persisted));
  checar('3 reconhecidos como iguais', envio2.body?.persisted?.unchanged === 3);

  // ── 4. Alteração ───────────────────────────────────────────────────────────
  console.log('\n4. Reenvio com um valor alterado');
  const envio3 = await chamar('/erp/orcamentos/sync', {
    metodo: 'POST',
    corpo: {
      orcamentos: [
        orcamento(ids[0], { valorTotal: 4321.99, situacao: 'FATURADO' }),
        orcamento(ids[1]),
        orcamento(ids[2])
      ]
    }
  });
  checar('1 atualizado', envio3.body?.persisted?.updated === 1, JSON.stringify(envio3.body?.persisted));
  checar('2 iguais', envio3.body?.persisted?.unchanged === 2);

  // ── 5. Dado ruim ───────────────────────────────────────────────────────────
  console.log('\n5. Linha sem externalId — rejeitada sem derrubar o lote');
  const envio4 = await chamar('/erp/orcamentos/sync', {
    metodo: 'POST',
    corpo: {
      orcamentos: [orcamento(`SIM-${marca}-D`), { erpCompanyId: ERP_COMPANY_ID, numero: 'sem-id' }]
    }
  });
  checar('lote ainda responde 200', envio4.status === 200, `status ${envio4.status}`);
  checar('o orçamento bom entrou', envio4.body?.persisted?.inserted === 1);
  checar('1 rejeitado, nomeado', envio4.body?.persisted?.rejected?.length === 1, JSON.stringify(envio4.body?.persisted?.motivos));

  // ── 6. Status ──────────────────────────────────────────────────────────────
  console.log('\n6. Status no servidor');
  const st = await chamar('/erp/status');
  checar('responde 200', st.status === 200, `status ${st.status}`);
  console.log(`       total de orçamentos da empresa: ${st.body?.totalOrcamentos}`);
  console.log(`       último recebido: ${st.body?.ultimoRecebido?.externalId} em ${st.body?.ultimoRecebido?.syncedAt}`);

  // ── Fim ────────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(56)}`);
  if (falhas === 0) {
    console.log('  Tudo certo — a API está recebendo e deduplicando.');
  } else {
    console.log(`  ${falhas} verificação(ões) falharam.`);
  }
  console.log(`${'='.repeat(56)}`);
  console.log(`\nOs orçamentos de teste começam com "SIM-${marca}-".`);
  console.log('Apague-os pelo painel quando terminar — este script não apaga nada.\n');

  process.exit(falhas > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nErro ao falar com a API:', err.message);
  console.error(`Confira se ${API} está acessível desta máquina.\n`);
  process.exit(1);
});
