const fs = require('fs');
const path = require('path');

// Garante que o diretório de logs existe
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function dataLocalFormatada(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function getLogFileName() {
  return path.join(logsDir, `zaprun-${dataLocalFormatada(new Date())}.log`);
}

function formatMessage(level, msg) {
  const agora = new Date();
  const horaString = agora.toLocaleTimeString('pt-BR');
  return `[${dataLocalFormatada(agora)} ${horaString}] [${level}] ${msg}\n`;
}

function writeToLog(level, msg) {
  const logFile = getLogFileName();
  const formatted = formatMessage(level, msg);
  
  // Imprime no console também para compatibilidade
  if (level === 'ERROR') {
    console.error(formatted.trim());
  } else {
    console.log(formatted.trim());
  }

  // Grava no arquivo diário
  try {
    fs.appendFileSync(logFile, formatted, 'utf8');
  } catch (err) {
    console.error('Falha ao gravar no arquivo de log:', err);
  }
}

function logInfo(msg) {
  writeToLog('INFO', msg);
}

function logWarn(msg) {
  writeToLog('WARN', msg);
}

function logError(msg, error = null) {
  let fullMsg = msg;
  if (error) {
    fullMsg += ` | Err: ${error.message || error}`;
    if (error.stack) {
      fullMsg += `\n${error.stack}`;
    }
  }
  writeToLog('ERROR', fullMsg);
}

module.exports = {
  logInfo,
  logWarn,
  logError
};