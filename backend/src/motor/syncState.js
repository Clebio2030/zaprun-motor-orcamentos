// motor/syncState.js
// Estado local do Motor, gravado em backend/sync_state.json.
//
// O arquivo é PRESERVADO pelo updater (preservePaths), então ele guarda só o
// que é legítimo por-máquina: até onde já sincronizamos e um hash para pular
// ciclo sem mudança. Nunca guarde config de frota aqui — isso vem do handshake.
//
// Formato (uma entrada por IDEMPRESA do ERP):
//   { "1": { "hash": "...", "lastSyncedAt": "2026-08-27T12:00:00.000Z" } }
//
// Ausência de entrada = empresa nunca sincronizada → o ciclo usa a janela de
// carga inicial (mais larga). Isso é o que torna o Motor auto-curável: apagar
// o arquivo força uma recarga completa, e nada mais.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

// Sobrescrevível por env para testes isolados (não toca no estado de produção).
const STATE_FILE_PATH =
  process.env.ZAPRUN_STATE_FILE || path.join(__dirname, '..', '..', 'sync_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (err) {
    // Estado corrompido não pode derrubar o serviço: tratamos como "nunca
    // sincronizou" e o próximo ciclo reconstrói tudo.
    logError('[ZapRun] Erro ao ler sync_state.json (será tratado como vazio):', err);
  }
  return {};
}

function saveState(state) {
  try {
    // Escrita atômica: grava num temporário e renomeia. Sem isto, uma queda de
    // energia no meio do writeFileSync deixaria um JSON truncado — e o Motor
    // recarregaria 3 anos de orçamento no próximo boot.
    const tmp = `${STATE_FILE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE_PATH);
  } catch (err) {
    logError('[ZapRun] Erro ao salvar sync_state.json:', err);
  }
}

/**
 * Hash estável de um conjunto de orçamentos.
 *
 * Ordena por externalId antes de alimentar o hash: a view pode devolver as
 * linhas em ordem diferente entre ciclos (ORDER BY por data, com empates), e
 * sem ordenar o hash mudaria sozinho, forçando reenvio do lote inteiro.
 *
 * O campo `raw` fica de FORA: ele carrega colunas voláteis do ERP (timestamps
 * de log, contadores) que mudam sem que o orçamento tenha mudado.
 */
function generateHash(orcamentos) {
  const hash = crypto.createHash('md5');
  const ordenados = [...(orcamentos || [])].sort((a, b) =>
    String(a.externalId).localeCompare(String(b.externalId))
  );
  for (const o of ordenados) {
    const { raw, itens, ...cabecalho } = o;
    hash.update(JSON.stringify(cabecalho));
    for (const item of itens || []) {
      const { raw: _itemRaw, ...campos } = item;
      hash.update(JSON.stringify(campos));
    }
  }
  return hash.digest('hex');
}

/**
 * @param {number|string} erpCompanyId
 * @returns {string|null} ISO do último sync bem-sucedido, ou null se nunca houve.
 */
function getLastSyncedAt(erpCompanyId) {
  return loadState()[String(erpCompanyId)]?.lastSyncedAt ?? null;
}

/**
 * @returns {{ changed: boolean, hash: string }}
 */
function checkStateChanged(erpCompanyId, orcamentos) {
  const state = loadState();
  const currentHash = generateHash(orcamentos);
  const previousHash = state[String(erpCompanyId)]?.hash ?? null;
  return { changed: currentHash !== previousHash, hash: currentHash };
}

/** Grava hash + timestamp. Só chamado quando a API CONFIRMOU a entrega. */
function updateState(erpCompanyId, newHash) {
  const state = loadState();
  state[String(erpCompanyId)] = {
    hash: newHash,
    lastSyncedAt: new Date().toISOString()
  };
  saveState(state);
}

/** Snapshot do estado — servido em GET /status para diagnóstico sem RDP. */
function snapshotState() {
  return loadState();
}

module.exports = {
  checkStateChanged,
  getLastSyncedAt,
  updateState,
  snapshotState,
  generateHash,
  STATE_FILE_PATH
};
