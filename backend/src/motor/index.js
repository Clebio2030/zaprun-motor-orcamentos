// motor/index.js
// Orquestrador do Motor ZapRun Orçamentos.
//
// Ciclo:
//   1. GET /erp/handshake      → confirma o token e recebe a config de frota
//   2. Lê a view ZAPRUN_ORCAMENTOS do Firebird na janela de datas
//   3. Agrupa por IDEMPRESA e pula quem não mudou (hash)
//   4. POST /erp/orcamentos/sync em lotes ordenados, com fail-fast
//   5. Só grava o hash depois que a API CONFIRMA a contagem entregue
//
// Regra de ouro herdada e mantida: NUNCA confie só no 200. O hash é o carimbo
// de "chegou inteiro"; gravá-lo cedo demais faz o Motor esquecer dado que a API
// nunca recebeu.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const cron = require('node-cron');
const crypto = require('crypto');
const { logInfo, logWarn, logError } = require('../logger');
const { handshake, enviarOrcamentos, fatiarLote } = require('./sender');
const { extrairOrcamentos, listarEmpresasDoErp } = require('./extractor');
const { checkStateChanged, getLastSyncedAt, updateState } = require('./syncState');
const { runDatabaseMigrations } = require('./migrations');

const SOURCE_VERSION = require('../../package.json').version;

// Defaults usados quando o handshake não responde ou omite o campo. São
// DEFAULTS NO CÓDIGO de propósito — nunca no `.env`, que é preservado no update
// e por isso nunca propagaria uma mudança para a frota.
const PADRAO = {
  cronExpr: '0 8-22 * * *',   // de hora em hora, das 08h às 22h
  chunkSize: 500,             // cabe folgado no bodyParser de 5 MB do ZapRun
  janelaDias: 90,             // ciclo normal: pega retroativo recente
  janelaInicialDias: 1095     // 1ª carga da empresa: 3 anos
};

let cicloEmAndamento = false;
let cronTask = null;
let cronExprAtual = null;
let ultimoCiclo = null;

// ── Ciclo ────────────────────────────────────────────────────────────────────

async function runMotor() {
  if (cicloEmAndamento) {
    logWarn('[ZapRun] Ciclo anterior ainda em andamento. Ignorando este disparo.');
    return;
  }
  cicloEmAndamento = true;

  const inicio = Date.now();
  const dataReferencia = hojeFormatado();
  const resumo = { empresas: 0, enviados: 0, inalterados: 0, falhas: 0, erro: null };

  try {
    const config = await resolverConfig();

    if (!config.ativo) {
      logWarn('[ZapRun] Integração desativada no servidor para esta empresa. Ciclo encerrado.');
      return;
    }

    const permitidas = Array.isArray(config.erpCompanyIds) && config.erpCompanyIds.length
      ? config.erpCompanyIds.map(Number)
      : null;

    // Extrai UMA vez com a janela mais larga necessária e recorta por empresa
    // depois. Uma consulta por empresa custaria N varreduras na view — e a view
    // do ERP costuma ser cara.
    const janelas = calcularJanelas(permitidas, config);
    const desdeMaisAntigo = janelas.desdeMaisAntigo;

    logInfo(`[ZapRun] Iniciando ciclo — referência ${dataReferencia}, extraindo desde ${desdeMaisAntigo}.`);

    const { orcamentos, linhas } = await extrairOrcamentos(desdeMaisAntigo, permitidas);
    logInfo(`[ZapRun] View devolveu ${linhas} linha(s) → ${orcamentos.length} orçamento(s).`);

    if (orcamentos.length === 0) {
      await diagnosticarVazio(permitidas);
      return;
    }

    const porEmpresa = agruparPorEmpresa(orcamentos);
    resumo.empresas = porEmpresa.size;

    for (const [erpCompanyId, lista] of porEmpresa) {
      const desdeEmpresa = janelas.porEmpresa.get(erpCompanyId) || desdeMaisAntigo;
      const modo = getLastSyncedAt(erpCompanyId) ? 'incremental' : 'full';

      // Recorte final: a extração usou a janela mais larga entre as empresas;
      // cada empresa só envia o que cabe na SUA janela.
      const doEscopo = lista.filter(
        o => !o.emitidoEm || o.emitidoEm >= desdeEmpresa
      );

      const { changed, hash } = checkStateChanged(erpCompanyId, doEscopo);
      if (!changed) {
        logInfo(`[ZapRun] Empresa ${erpCompanyId}: ${doEscopo.length} orçamento(s), nada mudou. Pulando envio.`);
        resumo.inalterados++;
        continue;
      }

      logInfo(`[ZapRun] Empresa ${erpCompanyId}: enviando ${doEscopo.length} orçamento(s) — modo ${modo}, desde ${desdeEmpresa}.`);

      const ok = await enviarEmpresa({
        erpCompanyId,
        orcamentos: doEscopo,
        chunkSize: config.chunkSize,
        meta: { dataReferencia, syncMode: modo, desde: desdeEmpresa }
      });

      if (ok) {
        updateState(erpCompanyId, hash);
        resumo.enviados++;
        logInfo(`[ZapRun] Empresa ${erpCompanyId}: entrega confirmada — hash salvo.`);
      } else {
        resumo.falhas++;
        logWarn(`[ZapRun] Empresa ${erpCompanyId}: hash NÃO salvo. O próximo ciclo reenviará tudo.`);
      }
    }
  } catch (err) {
    resumo.erro = err.message;
    logError('[ZapRun] Erro inesperado no ciclo do motor:', err);
  } finally {
    cicloEmAndamento = false;
    const duracaoMs = Date.now() - inicio;
    ultimoCiclo = { ...resumo, dataReferencia, duracaoMs, em: new Date().toISOString() };
    logInfo(
      `[ZapRun] Ciclo concluído: empresas=${resumo.empresas}, enviadas=${resumo.enviados}, inalteradas=${resumo.inalterados}, falhas=${resumo.falhas}, duração=${duracaoMs}ms.`
    );
  }
}

/**
 * Envia os orçamentos de UMA empresa como um stream de lotes ordenado.
 *
 * `snapshotId` identifica a entrega inteira; `expectedTotal` é congelado antes
 * do primeiro lote. Ao primeiro lote que falha, aborta (fail-fast): empurrar os
 * seguintes só gravaria metade do dado e mascararia a falha. Sem hash salvo, o
 * próximo ciclo refaz a entrega inteira.
 *
 * @returns {Promise<boolean>} true só se a API confirmou TODAS as linhas.
 */
async function enviarEmpresa({ erpCompanyId, orcamentos, chunkSize, meta }) {
  const expectedTotal = orcamentos.length;
  const snapshotId = crypto.randomUUID();
  const lotes = fatiarLote(orcamentos, chunkSize);
  let recebidosConfirmados = 0;

  for (let i = 0; i < lotes.length; i++) {
    if (lotes.length > 1) {
      logInfo(`[ZapRun] Empresa ${erpCompanyId}: lote ${i + 1}/${lotes.length} (${lotes[i].length} orçamentos)...`);
    }

    const resp = await enviarOrcamentos({
      ...meta,
      sourceVersion: SOURCE_VERSION,
      snapshotId,
      expectedTotal,
      chunkInfo: { atual: i + 1, total: lotes.length },
      orcamentos: lotes[i]
    });

    if (!resp.ok) {
      logWarn(`[ZapRun] Empresa ${erpCompanyId}: lote ${i + 1}/${lotes.length} falhou — abortando entrega (snapshot ${snapshotId}).`);
      return false;
    }

    const p = resp.persisted || {};
    recebidosConfirmados += Number(p.received || 0);

    if (Array.isArray(p.rejected) && p.rejected.length > 0) {
      // Linha rejeitada é dado perdido. Tem que aparecer nomeada no log, senão
      // ninguém descobre sem RDP na máquina do cliente.
      logWarn(
        `[ZapRun] Empresa ${erpCompanyId}: a API rejeitou ${p.rejected.length} orçamento(s): ${p.rejected.slice(0, 10).join(', ')}`
      );
      return false;
    }

    if (i + 1 === lotes.length) {
      logInfo(
        `[ZapRun] Empresa ${erpCompanyId}: API confirmou ${recebidosConfirmados} de ${expectedTotal} (novos=${p.inserted ?? '?'}, atualizados=${p.updated ?? '?'}, iguais=${p.unchanged ?? '?'}).`
      );
    }
  }

  // Verificação fim-a-fim. É ISTO que autoriza gravar o hash — não o 200.
  if (recebidosConfirmados !== expectedTotal) {
    logError(
      `[ZapRun] Empresa ${erpCompanyId}: API recebeu ${recebidosConfirmados}, esperado ${expectedTotal} — entrega truncada (snapshot ${snapshotId}).`
    );
    return false;
  }

  return true;
}

// ── Config e janelas ─────────────────────────────────────────────────────────

/** Handshake com fallback nos defaults do código. Nunca lança. */
async function resolverConfig() {
  const remoto = await handshake();

  if (!remoto) {
    // Servidor fora do ar não pode parar o Motor: ele segue com os defaults e
    // tenta de novo no próximo ciclo. O que NÃO fazemos é assumir `ativo` —
    // isso vem do servidor; sem resposta, mantemos ativo para não perder
    // janela de dado por instabilidade de rede nossa.
    logWarn('[ZapRun] Sem handshake — seguindo com a configuração padrão do código.');
    return { ativo: true, ...PADRAO, erpCompanyIds: null };
  }

  return {
    ativo: remoto.ativo !== false,
    cronExpr: remoto.cronExpr || PADRAO.cronExpr,
    chunkSize: Number(remoto.chunkSize) || PADRAO.chunkSize,
    janelaDias: Number(remoto.janelaDias) || PADRAO.janelaDias,
    janelaInicialDias: Number(remoto.janelaInicialDias) || PADRAO.janelaInicialDias,
    erpCompanyIds: remoto.erpCompanyIds || null,
    empresa: remoto.empresa || null
  };
}

/**
 * Decide a data inicial de cada empresa e a mais antiga entre todas (que é a
 * janela da consulta única ao Firebird).
 *
 * Empresa nunca sincronizada → janela inicial (3 anos). Já sincronizada →
 * janela normal (90 dias), larga o bastante para pegar orçamento retroativo.
 */
function calcularJanelas(permitidas, config) {
  const porEmpresa = new Map();
  const alvos = permitidas || [];

  for (const id of alvos) {
    const dias = getLastSyncedAt(id) ? config.janelaDias : config.janelaInicialDias;
    porEmpresa.set(Number(id), diasAtras(dias));
  }

  // Sem lista de empresas do servidor, não sabemos quais existem no ERP antes
  // de consultar. Usamos a janela inicial: mais larga, e o recorte por empresa
  // acontece depois, com o estado já conhecido.
  const desdeMaisAntigo = porEmpresa.size
    ? [...porEmpresa.values()].sort()[0]
    : diasAtras(config.janelaInicialDias);

  return { porEmpresa, desdeMaisAntigo };
}

function agruparPorEmpresa(orcamentos) {
  const mapa = new Map();
  for (const o of orcamentos) {
    const id = Number(o.erpCompanyId);
    if (!mapa.has(id)) mapa.set(id, []);
    mapa.get(id).push(o);
  }
  return mapa;
}

/**
 * Ciclo sem nenhum orçamento é ambíguo: pode ser "não há orçamento na janela"
 * ou "a view está vazia/errada". Distinguir isso pelo log evita uma sessão de
 * RDP na máquina do cliente.
 */
async function diagnosticarVazio(permitidas) {
  try {
    const noErp = await listarEmpresasDoErp();
    if (noErp.length === 0) {
      logWarn('[ZapRun] Nenhum orçamento e nenhuma empresa na view — confira se ZAPRUN_ORCAMENTOS foi criada e tem dados.');
      return;
    }
    if (permitidas && !noErp.some(id => permitidas.includes(id))) {
      logWarn(
        `[ZapRun] Nenhum orçamento: o token autoriza a(s) empresa(s) [${permitidas.join(', ')}], mas a view só tem [${noErp.join(', ')}]. Corrija o token no painel.`
      );
      return;
    }
    logInfo('[ZapRun] Nenhum orçamento novo na janela. Nada a enviar.');
  } catch (err) {
    logWarn(`[ZapRun] Nenhum orçamento na janela (diagnóstico da view falhou: ${err.message}).`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function diasAtras(dias) {
  const d = new Date();
  d.setDate(d.getDate() - Number(dias));
  d.setHours(0, 0, 0, 0);
  return formatarData(d);
}

function hojeFormatado() {
  return formatarData(new Date());
}

function formatarData(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Estado exposto em GET /status do servidor local. */
function estadoDoMotor() {
  return { cicloEmAndamento, cronExpr: cronExprAtual, ultimoCiclo, sourceVersion: SOURCE_VERSION };
}

// ── Cron ─────────────────────────────────────────────────────────────────────

/**
 * (Re)agenda o cron. A expressão vem do handshake, então o servidor pode mudar
 * o ritmo da frota inteira sem release e sem tocar no `.env` de ninguém.
 */
function aplicarCron(expr) {
  if (!cron.validate(expr)) {
    logWarn(`[ZapRun] Expressão de cron inválida vinda do servidor ("${expr}"). Mantendo "${cronExprAtual || PADRAO.cronExpr}".`);
    return;
  }
  if (expr === cronExprAtual) return;

  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(expr, () => {
    logInfo(`[ZapRun] Cron disparado (${expr}).`);
    runMotor();
  });
  cronExprAtual = expr;
  logInfo(`[ZapRun] Motor agendado — cron: ${expr}.`);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
// ZAPRUN_DISABLE_BOOTSTRAP=true permite que os testes carreguem este módulo sem
// subir cron nem conectar no Firebird.
if (process.env.ZAPRUN_DISABLE_BOOTSTRAP !== 'true') {
  aplicarCron(PADRAO.cronExpr);

  // Aplica as views no Firebird antes do primeiro ciclo. Falha aqui não pode
  // derrubar o serviço: sem view, o ciclo loga o erro e tenta de novo depois.
  runDatabaseMigrations()
    .catch(err => logError('[ZapRun] Erro na aplicação das views no boot:', err))
    .then(() => {
      // Reagenda com o ritmo que o servidor manda, e roda o primeiro ciclo já.
      // Sem isto, uma instalação nova ficaria até uma hora sem enviar nada, e o
      // implantador não teria como saber se funcionou antes de ir embora.
      runMotor().then(() => resolverConfig().then(c => aplicarCron(c.cronExpr)));
    });
}

module.exports = { runMotor, enviarEmpresa, calcularJanelas, agruparPorEmpresa, estadoDoMotor, PADRAO };
