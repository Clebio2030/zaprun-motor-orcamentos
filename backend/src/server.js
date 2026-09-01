// src/server.js
// Servidor HTTP local do Motor — escuta só em 127.0.0.1, na máquina do cliente.
//
// Ele NÃO é um painel: quem mostra orçamento é o ZapRun. Ele existe para duas
// coisas, ambas de operação:
//   /health   o updater usa para decidir se faz rollback depois de atualizar
//   /status   diagnóstico sem RDP: versão, último ciclo, estado do sync
//
// Qualquer rota nova aqui precisa passar no mesmo teste: "isso ajuda alguém a
// consertar uma instalação sem acessar a máquina?". Se não, o lugar é o ZapRun.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const firebird = require('node-firebird');

const { logInfo, logError } = require('./logger');
const { ensureUpdaterSchedule } = require('./ensureUpdaterSchedule');
const { snapshotState } = require('./motor/syncState');
const { estadoDasViews } = require('./motor/migrations');

// Sobe o motor (cron + primeiro ciclo).
const { runMotor, estadoDoMotor } = require('./motor');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ── Firebird ─────────────────────────────────────────────────────────────────

function opcoesFirebird() {
  return {
    host: process.env.FB_HOST || '127.0.0.1',
    port: Number(process.env.FB_PORT || 3050),
    database: process.env.FB_DATABASE || '',
    user: process.env.FB_USER || 'SYSDBA',
    password: process.env.FB_PASSWORD || 'masterkey',
    lowercase_keys: true,
    role: null,
    pageSize: 4096,
    charset: process.env.FB_CHARSET || 'WIN1252'
  };
}

/**
 * Conexão própria (fora do pool do motor) porque isto é um teste de vida: se o
 * pool estiver saturado por uma extração em andamento, o health check deve
 * responder mesmo assim — senão o updater interpretaria "ocupado" como
 * "quebrado" e faria rollback de uma versão sadia.
 */
function testarFirebird() {
  return new Promise(resolve => {
    const opcoes = opcoesFirebird();
    if (!opcoes.database) return resolve(false);

    firebird.attach(opcoes, (err, db) => {
      if (err) {
        logError('[ZapRun] Falha ao conectar no Firebird', err);
        return resolve(false);
      }
      db.query('SELECT 1 FROM RDB$DATABASE', [], errQ => {
        db.detach();
        if (errQ) {
          logError('[ZapRun] Falha na query de teste do Firebird', errQ);
          return resolve(false);
        }
        resolve(true);
      });
    });
  });
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// O updater espera 200 aqui depois de atualizar; qualquer outra coisa dispara
// rollback. Por isso responde 200 mesmo com o Firebird fora: banco caído é
// problema do cliente, não da versão que acabou de subir — reverter o código
// não consertaria e ainda desfaria uma atualização boa.
app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    firebird: (await testarFirebird()) ? 'ok' : 'error',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/status', async (_req, res) => {
  const token = process.env.ZAPRUN_TOKEN || '';
  res.json({
    ...estadoDoMotor(),
    apiUrl: process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br',
    // Só o prefixo: o token em claro não pode vazar num log ou print de tela.
    token: token ? `${token.slice(0, 12)}...` : '(não configurado)',
    firebird: (await testarFirebird()) ? 'ok' : 'error',
    database: process.env.FB_DATABASE || '(não configurado)',
    // Por que a view falhou, e não só o sintoma "Table unknown" do ciclo.
    views: estadoDasViews(),
    sincronizacao: snapshotState()
  });
});

// Força um ciclo agora. Serve ao implantador: instalou, quer ver chegar sem
// esperar a próxima hora. Não devolve o resultado do ciclo — ele pode levar
// minutos; o resultado se acompanha em /status.
app.post('/sync', (_req, res) => {
  runMotor();
  res.json({ ok: true, mensagem: 'Ciclo disparado. Acompanhe em /status.' });
});

app.listen(PORT, '127.0.0.1', () => {
  logInfo('================================================');
  logInfo(`  ZapRun Orçamentos rodando em http://127.0.0.1:${PORT}`);
  logInfo('================================================');

  try {
    ensureUpdaterSchedule();
  } catch (err) {
    logError('[ZapRun] Falha ao garantir o agendamento do updater', err);
  }
});
