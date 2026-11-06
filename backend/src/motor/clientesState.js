// motor/clientesState.js
// Estado local da carteira de clientes, em backend/clientes_state.json.
//
// Por que um hash POR CLIENTE, e não um hash do lote como em syncState.js:
// a carteira tem dezenas de milhares de clientes (50.457 na Zé Grande) e todo
// dia alguém compra. Com um hash só, uma venda reenviaria a carteira inteira;
// com um por cliente, vai só quem mudou — tipicamente algumas centenas.
//
// Formato:
//   {
//     "versao": 1,
//     "ultimoCompleto": "2026-11-05T09:40:00.000Z",   // último envio completo confirmado
//     "ultimoEnvio":    "2026-11-06T09:40:00.000Z",   // último ciclo que terminou bem
//     "hashes": { "123": "9f1c...", ... }              // CDCLIENTE → hash confirmado pela API
//   }
//
// O arquivo é PRESERVADO no update (ensureUpdaterPreservePath, no boot). Se
// mesmo assim sumir, ou corromper, o próximo ciclo manda tudo — que é o certo:
// a ingestão no servidor é idempotente.
//
// Só entra hash de cliente que a API CONFIRMOU. Gravar antes faz o Motor
// esquecer cliente que nunca chegou, e nada o traria de volta.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

const ARQUIVO =
  process.env.ZAPRUN_CLIENTES_STATE_FILE ||
  path.join(__dirname, '..', '..', 'clientes_state.json');

function vazio() {
  return { versao: 1, ultimoCompleto: null, ultimoEnvio: null, hashes: {} };
}

function carregar() {
  try {
    if (fs.existsSync(ARQUIVO)) {
      const raw = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      if (raw && typeof raw === 'object' && raw.hashes && typeof raw.hashes === 'object') {
        return { ...vazio(), ...raw };
      }
    }
  } catch (err) {
    logError('[ZapRun] Erro ao ler clientes_state.json (será tratado como vazio):', err);
  }
  return vazio();
}

function salvar(state) {
  try {
    // Escrita atômica, como em syncState.js: queda de energia no meio não pode
    // deixar um JSON truncado.
    const tmp = `${ARQUIVO}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, ARQUIVO);
  } catch (err) {
    logError('[ZapRun] Erro ao salvar clientes_state.json:', err);
  }
}

/**
 * Hash de um cliente, SEM o `raw` (mesma regra do syncState: colunas cruas do
 * ERP não decidem se o cliente mudou). 16 hex bastam para detectar mudança e
 * deixam o arquivo com ~1,5 MB para 50 mil clientes.
 */
function hashCliente(cliente) {
  const { raw, ...campos } = cliente || {};
  return crypto.createHash('md5').update(JSON.stringify(campos)).digest('hex').slice(0, 16);
}

/**
 * Decide se este ciclo manda a carteira INTEIRA.
 *
 *  - nunca houve completo;
 *  - o último completo é mais velho que `fullACadaDias` (rede de segurança: se
 *    algo se perdeu do lado de lá, volta em até uma semana sem ninguém pedir);
 *  - o servidor pediu (`completoDesde` mais novo que o último completo). É
 *    assim que se força uma recarga sem RDP — no ADR-159 a única saída era
 *    apagar o sync_state.json na máquina do cliente.
 */
function precisaCompleto(state, { fullACadaDias, completoDesde } = {}, agora = new Date()) {
  if (!state.ultimoCompleto) return true;
  const ultimo = new Date(state.ultimoCompleto);
  if (Number.isNaN(ultimo.getTime())) return true;

  const dias = Number(fullACadaDias);
  if (Number.isFinite(dias) && dias > 0) {
    if (agora.getTime() - ultimo.getTime() >= dias * 24 * 60 * 60 * 1000) return true;
  }

  if (completoDesde) {
    const pedido = new Date(completoDesde);
    if (!Number.isNaN(pedido.getTime()) && pedido.getTime() > ultimo.getTime()) return true;
  }

  return false;
}

/**
 * Quem precisa ir para a API neste ciclo.
 *
 * @returns {{ enviar: object[], hashes: Map<string,string> }}
 *   `hashes` tem o hash ATUAL de todos os clientes lidos — é dele que saem os
 *   valores gravados depois de cada lote confirmado.
 */
function calcularDiferenca(clientes, state, completo) {
  const hashes = new Map();
  const enviar = [];
  for (const c of clientes || []) {
    const h = hashCliente(c);
    hashes.set(String(c.externalId), h);
    if (completo || state.hashes[String(c.externalId)] !== h) enviar.push(c);
  }
  return { enviar, hashes };
}

/** Marca como entregues os clientes de um lote que a API confirmou. */
function registrarConfirmados(state, lote, hashes, rejeitados = []) {
  const fora = new Set((rejeitados || []).map(String));
  for (const c of lote || []) {
    const id = String(c.externalId);
    if (fora.has(id)) {
      // Rejeitado não pode ficar com hash velho "certo": sai, para ir de novo.
      delete state.hashes[id];
      continue;
    }
    const h = hashes.get(id);
    if (h) state.hashes[id] = h;
  }
}

/**
 * Depois de um completo íntegro: esquece quem não veio mais na view (cliente
 * apagado no ERP). Sem isto o arquivo só cresceria.
 */
function podar(state, hashes) {
  for (const id of Object.keys(state.hashes)) {
    if (!hashes.has(id)) delete state.hashes[id];
  }
}

/** Resumo para o GET /status — sem a lista de hashes. */
function resumo(state = carregar()) {
  return {
    ultimoCompleto: state.ultimoCompleto,
    ultimoEnvio: state.ultimoEnvio,
    clientesConfirmados: Object.keys(state.hashes || {}).length
  };
}

module.exports = {
  ARQUIVO,
  carregar,
  salvar,
  hashCliente,
  precisaCompleto,
  calcularDiferenca,
  registrarConfirmados,
  podar,
  resumo
};
