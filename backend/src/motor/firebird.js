// motor/firebird.js
// Conexão dedicada ao Motor ZapRun Orçamentos.
// Usa as mesmas variáveis de ambiente do projeto (FB_*),
// com suporte a FB_CHARSET para bases WIN1252.
//
// Pool de conexões: reutiliza FB_POOL_SIZE conexões abertas (padrão: 3).
// Timeout por query: FB_QUERY_TIMEOUT ms (padrão: 90 000 ms).

const firebird = require('node-firebird');

const POOL_SIZE      = parseInt(process.env.FB_POOL_SIZE    || '3',     10);
const QUERY_TIMEOUT_MS = parseInt(process.env.FB_QUERY_TIMEOUT || '300000', 10);

function getOptions() {
  return {
    host:           process.env.FB_HOST     || '127.0.0.1',
    port:           Number(process.env.FB_PORT || 3050),
    database:       process.env.FB_DATABASE || '',
    user:           process.env.FB_USER     || 'SYSDBA',
    password:       process.env.FB_PASSWORD || 'masterkey',
    lowercase_keys: true,
    role:           null,
    pageSize:       4096,
    charset:        process.env.FB_CHARSET  || 'WIN1252'
  };
}

// Pool criado na primeira chamada e reutilizado em todo o processo.
let _pool = null;
function getPool() {
  if (!_pool) _pool = firebird.pool(POOL_SIZE, getOptions());
  return _pool;
}

/**
 * Executa uma query SQL parametrizada via pool de conexões.
 * Rejeita automaticamente após FB_QUERY_TIMEOUT ms para evitar
 * que queries travadas bloqueiem o ciclo indefinidamente.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Array>}
 */
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Firebird query timeout (${QUERY_TIMEOUT_MS}ms): ${sql.substring(0, 120)}`));
      }
    }, QUERY_TIMEOUT_MS);

    getPool().get((err, db) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
        return;
      }

      db.query(sql, params, (errQ, rows) => {
        clearTimeout(timer);
        db.detach(); // devolve ao pool
        if (!settled) {
          settled = true;
          if (errQ) return reject(errQ);
          resolve(rows || []);
        }
      });
    });
  });
}

module.exports = { query };
