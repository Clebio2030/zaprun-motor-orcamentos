// motor/sender.js
// Conversa com a API do ZapRun:
//   GET  /erp/handshake          → confirma o token e recebe a config de frota
//   POST /erp/orcamentos/sync    → entrega os orçamentos em lotes
//   POST /erp/clientes/sync      → entrega a carteira de clientes (Reativar Clientes)
//
// Retry: até RETRY_ATTEMPTS tentativas em erro 5xx/timeout. Erro 4xx do app
// (validação, token revogado) NÃO é retentado — insistir não conserta.

const axios = require('axios');
const { logInfo, logWarn, logError } = require('../logger');

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 60_000;
const POST_TIMEOUT_MS = parseInt(process.env.ZAPRUN_HTTP_TIMEOUT || '120000', 10);

// Teto de bytes por POST. O ZapRun tem bodyParser.json({ limit: '5mb' }) GLOBAL
// (app.ts) — um lote acima disso volta 413 antes de chegar na rota, e nenhum
// retry resolve. 3 MB deixa folga para o overhead do JSON e para orçamento com
// muitos itens. Quem respeita esse teto é fatiarLote(), abaixo.
const MAX_BYTES_POR_LOTE = parseInt(process.env.ZAPRUN_MAX_BYTES || '3000000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Integration-Token': process.env.ZAPRUN_TOKEN || ''
  };
}

function baseUrl() {
  const raw = process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br';
  return raw.replace(/\/+$/, '');
}

function resolverEspera(err) {
  const retryAfterSeg = err.response?.data?.retry_after;
  if (typeof retryAfterSeg === 'number') return retryAfterSeg * 1000;
  const header = err.response?.headers?.['retry-after'];
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  return RETRY_DELAY_MS;
}

/**
 * Um erro é transitório (vale retry) quando não tem status (timeout/DNS/rede),
 * é 5xx, ou é 429. Também cobre o 400 em HTML do nginx — que é infra, não
 * validação: aparece quando o retry bate na API ainda processando o lote
 * anterior. Um 400 do app vem em JSON e NÃO deve ser retentado.
 */
function ehTransitorio(err) {
  const status = err.response?.status;
  if (!status) return true;
  if (status >= 500 || status === 429) return true;
  return (
    status === 400 &&
    typeof err.response?.data === 'string' &&
    err.response.data.includes('nginx')
  );
}

function detalharErro(err) {
  if (!err.response) return err.message;
  const corpo = typeof err.response.data === 'string'
    ? err.response.data.slice(0, 300)
    : JSON.stringify(err.response.data);
  return `HTTP ${err.response.status}: ${corpo}`;
}

// ── Handshake ────────────────────────────────────────────────────────────────

/**
 * Confirma o token e busca a configuração de frota.
 *
 * Existe porque o `.env` do cliente é PRESERVADO no update: config colocada lá
 * nunca mais muda sozinha. Ritmo do cron, tamanho do lote e janela de datas são
 * decisões nossas, tomadas no servidor, e chegam aqui a cada ciclo.
 *
 * @returns {Promise<object|null>} config, ou null se não deu para falar com a API
 */
async function handshake() {
  const url = `${baseUrl()}/erp/handshake`;

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const { data } = await axios.get(url, { headers: getHeaders(), timeout: 30_000 });
      logInfo(
        `[ZapRun] Handshake OK — empresa: ${data?.empresa?.nome || '?'}, ativo: ${data?.ativo}, lote: ${data?.chunkSize}, janela: ${data?.janelaDias}d.`
      );
      return data;
    } catch (err) {
      if (ehTransitorio(err) && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(
          `[ZapRun] Handshake falhou (${err.response?.status || 'timeout'}). Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`
        );
        await sleep(espera);
        continue;
      }
      logError(`[ZapRun] Falha definitiva no handshake: ${detalharErro(err)}`);
      return null;
    }
  }
  return null;
}

// ── Envio ────────────────────────────────────────────────────────────────────

/**
 * POST com retry nos erros transitórios. Erro 4xx do app volta na hora.
 *
 * @param {string} rota     ex.: "/erp/orcamentos/sync"
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, persisted?: object, erro?: string, status?: number }>}
 */
async function postar(rota, payload) {
  const url = `${baseUrl()}${rota}`;

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const response = await axios.post(url, payload, {
        headers: getHeaders(),
        timeout: POST_TIMEOUT_MS
      });
      return { ok: true, persisted: response.data?.persisted };
    } catch (err) {
      if (ehTransitorio(err) && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(
          `[ZapRun] POST ${rota} retornou ${err.response?.status || 'timeout'}. Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`
        );
        await sleep(espera);
        continue;
      }
      const erro = detalharErro(err);
      logError(`[ZapRun] Falha definitiva no POST ${rota}: ${erro}`);
      return { ok: false, erro, status: err.response?.status };
    }
  }
  return { ok: false, erro: 'tentativas esgotadas' };
}

/** Orçamentos — POST /erp/orcamentos/sync. */
function enviarOrcamentos(payload) {
  return postar('/erp/orcamentos/sync', payload);
}

/**
 * Carteira de clientes — POST /erp/clientes/sync ("Reativar Clientes").
 * Mesmo contrato de integridade: `persisted.received` é o que vale.
 */
function enviarClientes(payload) {
  return postar('/erp/clientes/sync', payload);
}

// ── Fatiamento ───────────────────────────────────────────────────────────────

/**
 * Divide a lista em lotes que respeitam DUAS restrições: quantidade
 * (`chunkSize`, vem do handshake) e tamanho em bytes (`MAX_BYTES_POR_LOTE`,
 * imposto pelo bodyParser do ZapRun).
 *
 * O corte por bytes existe porque a contagem não prevê o tamanho: um orçamento
 * com 300 itens pesa o que 200 orçamentos simples pesam. Sem isso, um cliente
 * com pedidos grandes tomaria 413 e nunca sincronizaria — e o log diria só
 * "erro 400", sem pista nenhuma.
 *
 * Um único item maior que o teto vai sozinho no seu lote: cortá-lo seria perder
 * dado, e é melhor a API recusar um caso identificável do que o Motor mentir.
 *
 * @param {Array<object>} lista
 * @param {number} chunkSize
 * @param {number} maxBytes
 * @returns {Array<Array<object>>}
 */
function fatiarLote(lista, chunkSize, maxBytes = MAX_BYTES_POR_LOTE) {
  const limiteQtd = Math.max(1, Number(chunkSize) || 500);
  const lotes = [];
  let atual = [];
  let bytesAtual = 0;

  for (const item of lista || []) {
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');

    const estouraQtd = atual.length >= limiteQtd;
    const estouraBytes = atual.length > 0 && bytesAtual + bytes > maxBytes;

    if (estouraQtd || estouraBytes) {
      lotes.push(atual);
      atual = [];
      bytesAtual = 0;
    }

    atual.push(item);
    bytesAtual += bytes;
  }

  if (atual.length > 0) lotes.push(atual);
  return lotes;
}

module.exports = {
  handshake,
  enviarOrcamentos,
  enviarClientes,
  fatiarLote,
  MAX_BYTES_POR_LOTE
};
