// motor/clientes.js
// Ciclo da carteira de clientes ("Reativar Clientes" no ZapRun).
//
// Mesmo Motor, segundo relatório: a ideia é NÃO instalar outro serviço na
// máquina do cliente para cada leitura nova do ERP. O ciclo de orçamentos
// (motor/index.js) não muda; este roda ao lado, com ritmo próprio.
//
// Ciclo:
//   1. GET /erp/handshake — o recurso é OPT-IN: sem `clientes.ativo: true`
//      vindo do servidor, nada aqui roda (nem a view é criada no ERP).
//   2. Aplica sql/views_clientes.sql (uma vez por processo).
//   3. Lê a view ZAPRUN_CLIENTES inteira.
//   4. Compara cada cliente com o hash confirmado da última vez e separa só
//      quem mudou (ou todos, no envio completo).
//   5. POST /erp/clientes/sync em lotes; cada lote confirmado grava os hashes
//      dos clientes dele — nunca antes.
//
// Ritmo: 1 vez por dia (o servidor manda o cron). A view agrega a tabela de
// vendas inteira; ler de hora em hora pesaria na base do cliente para um dado
// cuja unidade é "dias sem comprar".

const cron = require('node-cron');
const crypto = require('crypto');
const { logInfo, logWarn, logError } = require('../logger');
const { query } = require('./firebird');
const { handshake, enviarClientes, fatiarLote } = require('./sender');
const { aplicarArquivoSql, SQL_CLIENTES_PATH } = require('./migrations');
const { SQL_CLIENTES, VIEW_CLIENTES, agruparClientes } = require('./mappingClientes');
const estado = require('./clientesState');

const SOURCE_VERSION = require('../../package.json').version;

// Defaults no CÓDIGO (nunca no .env). `ativo: false` é o ponto: servidor que
// não conhece o recurso (versão antiga da API) não manda o bloco `clientes`,
// e o Motor fica quieto.
const PADRAO_CLIENTES = {
  ativo: false,
  cronExpr: '40 6 * * *',  // 06:40, antes da loja abrir
  chunkSize: 1000,
  fullACadaDias: 7,
  completoDesde: null
};

// Ciclo que terminou bem há menos que isto não roda de novo no boot. Sem isto,
// cada reinício do serviço (update às 08h/19h) releria a carteira inteira.
const HORAS_PARA_RODAR_NO_BOOT = 20;

let emAndamento = false;
let cronTask = null;
let cronAtual = null;
let viewOk = false;
let ultimaView = { estado: 'nao-executado' };
let ultimoCiclo = null;

/** Bloco `clientes` do handshake → config completa. */
function lerConfig(remoto) {
  const c = remoto && typeof remoto.clientes === 'object' && remoto.clientes ? remoto.clientes : {};
  return {
    ativo: remoto ? remoto.ativo !== false && c.ativo === true : false,
    cronExpr: typeof c.cronExpr === 'string' && c.cronExpr ? c.cronExpr : PADRAO_CLIENTES.cronExpr,
    chunkSize: Number(c.chunkSize) || PADRAO_CLIENTES.chunkSize,
    fullACadaDias: Number(c.fullACadaDias) || PADRAO_CLIENTES.fullACadaDias,
    completoDesde: c.completoDesde || null,
    erpCompanyIds:
      remoto && Array.isArray(remoto.erpCompanyIds) && remoto.erpCompanyIds.length
        ? remoto.erpCompanyIds.map(Number)
        : null
  };
}

/**
 * Liga, troca ou desliga o cron da carteira conforme o servidor. Chamado a cada
 * handshake do ciclo de orçamentos — é assim que ligar o recurso no painel
 * chega na máquina do cliente em até uma hora, sem release e sem RDP.
 */
function agendar(cfg) {
  if (!cfg || !cfg.ativo) {
    if (cronTask) {
      cronTask.stop();
      cronTask = null;
      cronAtual = null;
      logInfo('[ZapRun/Clientes] Recurso desligado no servidor — agendamento removido.');
    }
    return;
  }
  if (!cron.validate(cfg.cronExpr)) {
    logWarn(`[ZapRun/Clientes] Cron inválido vindo do servidor ("${cfg.cronExpr}"). Mantendo "${cronAtual || '(nenhum)'}".`);
    return;
  }
  if (cfg.cronExpr === cronAtual) return;

  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(cfg.cronExpr, () => {
    logInfo(`[ZapRun/Clientes] Cron disparado (${cfg.cronExpr}).`);
    rodarClientes({ motivo: 'cron' });
  });
  cronAtual = cfg.cronExpr;
  logInfo(`[ZapRun/Clientes] Carteira agendada — cron: ${cfg.cronExpr}.`);
}

/** No boot: roda já se o recurso está ligado e o último envio bom é velho. */
function rodarSeAtrasado(cfg, agora = new Date()) {
  if (!cfg || !cfg.ativo) return false;
  const s = estado.carregar();
  const ultimo = s.ultimoEnvio ? new Date(s.ultimoEnvio).getTime() : 0;
  if (ultimo && agora.getTime() - ultimo < HORAS_PARA_RODAR_NO_BOOT * 3600 * 1000) return false;
  rodarClientes({ motivo: 'boot' });
  return true;
}

/**
 * Um ciclo completo da carteira. Nunca lança.
 * @param {{ motivo?: string, forcarCompleto?: boolean }} opcoes
 */
async function rodarClientes({ motivo = 'manual', forcarCompleto = false } = {}) {
  if (emAndamento) {
    logWarn('[ZapRun/Clientes] Ciclo anterior ainda em andamento. Ignorando este disparo.');
    return;
  }
  emAndamento = true;

  const inicio = Date.now();
  const resumo = {
    motivo,
    modo: null,
    lidos: 0,
    enviados: 0,
    confirmados: 0,
    rejeitados: 0,
    descartadas: 0,
    repetidas: 0,
    foraDoEscopo: 0,
    erro: null
  };

  try {
    const remoto = await handshake();
    if (!remoto) {
      // Diferente do ciclo de orçamentos, aqui SEM handshake não se roda: o
      // recurso é opt-in, e sem a palavra do servidor não lemos a carteira.
      resumo.erro = 'sem handshake';
      logWarn('[ZapRun/Clientes] Sem handshake — ciclo da carteira adiado.');
      return;
    }
    const cfg = lerConfig(remoto);
    agendar(cfg);
    if (!cfg.ativo) {
      resumo.erro = 'desligado no servidor';
      logInfo('[ZapRun/Clientes] Reativar Clientes não está ligado para esta empresa. Nada a fazer.');
      return;
    }

    if (!viewOk) {
      ultimaView = await aplicarArquivoSql(SQL_CLIENTES_PATH);
      viewOk = ultimaView.estado === 'ok';
      if (!viewOk) {
        resumo.erro = `view ${VIEW_CLIENTES} não aplicada`;
        logError(
          `[ZapRun/Clientes] A view ${VIEW_CLIENTES} não subiu (${(ultimaView.erros || []).map(e => e.erro || e).join(' | ')}). ` +
          'Confira as colunas com GET /diagnostico/colunas?tabelas=CLIENTE,SAIDAESTOQUE,MUNICIPIO,VENDEDOR,CONFIGURACAO'
        );
        return;
      }
    }

    const rows = await query(SQL_CLIENTES, []);
    const { clientes, descartadas, repetidas, foraDoEscopo } = agruparClientes(rows, cfg.erpCompanyIds);
    resumo.lidos = clientes.length;
    resumo.descartadas = descartadas;
    resumo.repetidas = repetidas;
    resumo.foraDoEscopo = foraDoEscopo;

    logInfo(`[ZapRun/Clientes] View devolveu ${rows.length} linha(s) → ${clientes.length} cliente(s).`);
    if (descartadas > 0) {
      logWarn(`[ZapRun/Clientes] ${descartadas} linha(s) sem CDCLIENTE — descartadas. Verifique a view.`);
    }
    if (repetidas > 0) {
      logWarn(
        `[ZapRun/Clientes] ${repetidas} CDCLIENTE repetido(s) na view — vale a última linha. ` +
        'Se o ERP tem um cadastro por loja com o mesmo código, a view precisa ser ajustada.'
      );
    }
    if (foraDoEscopo > 0) {
      logInfo(`[ZapRun/Clientes] ${foraDoEscopo} cliente(s) de loja não autorizada pelo token — ignorados.`);
    }

    if (clientes.length === 0) {
      resumo.erro = 'view vazia';
      logWarn(`[ZapRun/Clientes] ${VIEW_CLIENTES} não devolveu nenhum cliente. Nada enviado.`);
      return;
    }

    const state = estado.carregar();
    const completo = forcarCompleto || estado.precisaCompleto(state, cfg);
    resumo.modo = completo ? 'full' : 'incremental';
    const { enviar, hashes } = estado.calcularDiferenca(clientes, state, completo);
    resumo.enviados = enviar.length;

    if (enviar.length === 0) {
      state.ultimoEnvio = new Date().toISOString();
      estado.salvar(state);
      logInfo(`[ZapRun/Clientes] ${clientes.length} cliente(s), nenhum mudou. Nada a enviar.`);
      return;
    }

    logInfo(`[ZapRun/Clientes] Enviando ${enviar.length} de ${clientes.length} cliente(s) — modo ${resumo.modo}.`);

    const r = await enviarLotes({ enviar, hashes, state, chunkSize: cfg.chunkSize, modo: resumo.modo, totalCarteira: clientes.length });
    resumo.confirmados = r.confirmados;
    resumo.rejeitados = r.rejeitados;

    if (!r.ok) {
      resumo.erro = r.erro || 'entrega incompleta';
      logWarn(
        `[ZapRun/Clientes] Entrega incompleta (${r.confirmados} de ${enviar.length} confirmados). ` +
        'Os confirmados ficam gravados; o resto vai no próximo ciclo.'
      );
      return;
    }

    if (completo && r.rejeitados === 0) {
      estado.podar(state, hashes);
      state.ultimoCompleto = new Date().toISOString();
    }
    state.ultimoEnvio = new Date().toISOString();
    estado.salvar(state);
    logInfo(
      `[ZapRun/Clientes] Entrega confirmada: ${r.confirmados} cliente(s)` +
      (r.rejeitados ? `, ${r.rejeitados} rejeitado(s) — vão de novo no próximo ciclo.` : '.')
    );
  } catch (err) {
    resumo.erro = err.message;
    logError('[ZapRun/Clientes] Erro inesperado no ciclo da carteira:', err);
  } finally {
    emAndamento = false;
    ultimoCiclo = { ...resumo, duracaoMs: Date.now() - inicio, em: new Date().toISOString() };
    logInfo(
      `[ZapRun/Clientes] Ciclo concluído (${motivo}): lidos=${resumo.lidos}, enviados=${resumo.enviados}, ` +
      `confirmados=${resumo.confirmados}, rejeitados=${resumo.rejeitados}, duração=${ultimoCiclo.duracaoMs}ms.`
    );
  }
}

/**
 * Manda os lotes em ordem. Cada lote confirmado é gravado na hora: numa
 * carteira de 50 mil, um lote que falha no meio não pode jogar fora os 40 que
 * já chegaram.
 *
 * Confirmado = `received + rejected` cobre o lote inteiro. Rejeitado é nomeado
 * no log e fica sem hash (vai de novo amanhã); não aborta a entrega — um
 * cliente com dado ruim não pode segurar a carteira inteira para sempre.
 */
function gerarUUID() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

async function enviarLotes({ enviar, hashes, state, chunkSize, modo, totalCarteira, postar = enviarClientes, salvar = estado.salvar }) {
  const snapshotId = gerarUUID();
  const lotes = fatiarLote(enviar, chunkSize);
  let confirmados = 0;
  let rejeitados = 0;

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    const resp = await postar({
      sourceVersion: SOURCE_VERSION,
      syncMode: modo,
      snapshotId,
      expectedTotal: enviar.length,
      totalCarteira,
      chunkInfo: { atual: i + 1, total: lotes.length },
      clientes: lote
    });

    if (!resp.ok) {
      return { ok: false, confirmados, rejeitados, erro: `lote ${i + 1}/${lotes.length}: ${resp.erro || 'falhou'}` };
    }

    const p = resp.persisted || {};
    const recebidos = Number(p.received || 0);
    const rejeitadosLote = Array.isArray(p.rejected) ? p.rejected.map(String) : [];

    if (recebidos + rejeitadosLote.length !== lote.length) {
      logError(
        `[ZapRun/Clientes] Lote ${i + 1}/${lotes.length}: API confirmou ${recebidos} + ${rejeitadosLote.length} rejeitado(s) de ${lote.length} — entrega truncada (snapshot ${snapshotId}).`
      );
      return { ok: false, confirmados, rejeitados, erro: 'contagem não bate' };
    }

    if (rejeitadosLote.length) {
      logWarn(
        `[ZapRun/Clientes] Lote ${i + 1}/${lotes.length}: a API rejeitou ${rejeitadosLote.length} cliente(s): ` +
        `${rejeitadosLote.slice(0, 10).join(', ')}${Array.isArray(p.motivos) && p.motivos.length ? ` — ${p.motivos.slice(0, 3).join('; ')}` : ''}`
      );
    }

    estado.registrarConfirmados(state, lote, hashes, rejeitadosLote);
    salvar(state);
    confirmados += recebidos;
    rejeitados += rejeitadosLote.length;

    if (lotes.length > 1) {
      logInfo(`[ZapRun/Clientes] Lote ${i + 1}/${lotes.length} confirmado (${recebidos}).`);
    }
  }

  return { ok: true, confirmados, rejeitados };
}

/** GET /status. */
function estadoClientes() {
  return {
    agendado: cronAtual,
    emAndamento,
    view: ultimaView,
    ultimoCiclo,
    ...estado.resumo()
  };
}

module.exports = {
  PADRAO_CLIENTES,
  lerConfig,
  agendar,
  rodarSeAtrasado,
  rodarClientes,
  enviarLotes,
  estadoClientes
};
