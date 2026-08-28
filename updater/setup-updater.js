const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'updater-config.json');
const projectRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

const args = process.argv.slice(2);
const serviceName = args[0];
const port = args[1];

if (!serviceName || !port) {
  console.error('Uso: node setup-updater.js <serviceName> <port>');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error('Arquivo updater-config.json nao encontrado.');
  process.exit(1);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  config.serviceName = serviceName;
  config.healthUrl = `http://127.0.0.1:${port}/health`;
  config.backupDir = `${projectRoot}/updater/backups`;
  config.tempDir = `${projectRoot}/updater/temp`;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('Configuracao do atualizador atualizada para:', serviceName, 'na porta', port);
} catch (err) {
  console.error('Erro ao atualizar updater-config.json:', err.message);
  process.exit(1);
}
