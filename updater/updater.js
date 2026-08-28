const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const UPDATER_DIR = __dirname;
const CONFIG_PATH = path.join(UPDATER_DIR, 'updater-config.json');
const VERSION_PATH = path.join(UPDATER_DIR, 'version.json');
const LOG_PATH = path.join(UPDATER_DIR, 'updater.log');

function writeLog(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(LOG_PATH, entry, 'utf8');
}

function log(message) {
  const line = `[Updater] ${message}`;
  console.log(line);
  writeLog(line);
}

function warn(message) {
  const line = `[Updater][WARN] ${message}`;
  console.warn(line);
  writeLog(line);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function normalizeVersion(version) {
  return String(version || '0.0.0').trim().replace(/^v/i, '');
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
  const max = Math.max(pa.length, pb.length);

  for (let i = 0; i < max; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRel(relPath) {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isPreserved(relPath, preservePaths) {
  const normalized = toRel(relPath);
  return preservePaths.some((item) => {
    const target = toRel(item);
    return normalized === target || normalized.startsWith(`${target}/`);
  });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyPath(src, dest) {
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(requestJson(res.headers.location, headers));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Falha ao consultar GitHub: HTTP ${res.statusCode} - ${body}`));
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Resposta JSON inválida do GitHub: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
  });
}

function downloadFile(url, destination, headers = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destination));
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destination, headers));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Falha no download: HTTP ${res.statusCode}`));
      }

      const file = fs.createWriteStream(destination);
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve(destination));
      });

      file.on('error', (error) => {
        fs.unlink(destination, () => reject(error));
      });
    });

    req.on('error', reject);
  });
}

function buildGitHubHeaders(config) {
  const headers = {
    'User-Agent': 'ZapRunOrcamentosUpdater',
    Accept: 'application/vnd.github+json'
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  return headers;
}

async function fetchLatestRelease(config) {
  const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/releases/latest`;
  return requestJson(url, buildGitHubHeaders(config));
}

function chooseDownloadSource(release, config) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const hint = String(config.releaseAssetNameContains || '').trim().toLowerCase();

  if (hint) {
    const found = assets.find((asset) => String(asset.name || '').toLowerCase().includes(hint));
    if (found) {
      return {
        url: found.browser_download_url,
        name: found.name || 'release.zip'
      };
    }
  }

  const zipAsset = assets.find((asset) => String(asset.name || '').toLowerCase().endsWith('.zip'));
  if (zipAsset) {
    return {
      url: zipAsset.browser_download_url,
      name: zipAsset.name || 'release.zip'
    };
  }

  return {
    url: release.zipball_url,
    name: `${normalizeVersion(release.tag_name)}.zip`
  };
}

function expandZip(zipFile, destination) {
  ensureDir(destination);
  const command = `Expand-Archive -Path \"${zipFile}\" -DestinationPath \"${destination}\" -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error('Falha ao extrair o pacote baixado.');
  }
}

function detectPackageRoot(extractDir) {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
}

function backupManagedPaths(rootDir, backupDir, managedPaths) {
  ensureDir(backupDir);

  for (const rel of managedPaths) {
    const src = path.join(rootDir, rel);
    if (!fs.existsSync(src)) continue;

    const dest = path.join(backupDir, rel);
    copyPath(src, dest);
  }
}

function syncManagedPaths(sourceRoot, projectRoot, managedPaths, preservePaths) {
  for (const rel of managedPaths) {
    const sourcePath = path.join(sourceRoot, rel);
    const destPath = path.join(projectRoot, rel);
    const normalizedRel = toRel(rel);

    if (!fs.existsSync(sourcePath)) {
      if (fs.existsSync(destPath) && !isPreserved(normalizedRel, preservePaths)) {
        removePath(destPath);
      }
      continue;
    }

    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      syncDirectory(sourcePath, destPath, normalizedRel, preservePaths);
    } else {
      if (!isPreserved(normalizedRel, preservePaths)) {
        ensureDir(path.dirname(destPath));
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }
}

function syncDirectory(sourceDir, destDir, relBase, preservePaths) {
  if (!fs.existsSync(destDir)) {
    ensureDir(destDir);
  }

  const sourceEntries = new Map();
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    sourceEntries.set(entry.name, entry);
  }

  for (const destEntry of fs.readdirSync(destDir, { withFileTypes: true })) {
    const childRel = toRel(path.posix.join(relBase, destEntry.name));
    if (isPreserved(childRel, preservePaths)) continue;
    if (!sourceEntries.has(destEntry.name)) {
      removePath(path.join(destDir, destEntry.name));
    }
  }

  for (const [name, entry] of sourceEntries.entries()) {
    const sourceChild = path.join(sourceDir, name);
    const destChild = path.join(destDir, name);
    const childRel = toRel(path.posix.join(relBase, name));

    if (isPreserved(childRel, preservePaths)) {
      continue;
    }

    if (entry.isDirectory()) {
      syncDirectory(sourceChild, destChild, childRel, preservePaths);
      continue;
    }

    ensureDir(path.dirname(destChild));
    fs.copyFileSync(sourceChild, destChild);
  }
}

function serviceExists(serviceName) {
  if (!serviceName) return false;
  const result = spawnSync('sc', ['query', serviceName], { encoding: 'utf8' });
  return result.status === 0;
}

function stopService(serviceName) {
  if (!serviceName) return false;
  if (!serviceExists(serviceName)) {
    warn(`Serviço ${serviceName} não encontrado. Vou seguir sem parar serviço.`);
    return false;
  }

  log(`Parando serviço ${serviceName}...`);
  const result = spawnSync('net', ['stop', serviceName], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Falha ao parar o serviço ${serviceName}.`);
  }

  return true;
}

function startService(serviceName) {
  if (!serviceName) return false;
  if (!serviceExists(serviceName)) {
    warn(`Serviço ${serviceName} não encontrado. Vou seguir sem iniciar serviço.`);
    return false;
  }

  log(`Iniciando serviço ${serviceName}...`);
  const result = spawnSync('net', ['start', serviceName], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Falha ao iniciar o serviço ${serviceName}.`);
  }

  return true;
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function healthCheck(url, attempts = 12, delayMs = 5000) {
  if (!url) {
    warn('Health check desativado porque healthUrl está vazio.');
    return;
  }

  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await requestStatus(url);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        log(`Health check OK em ${url}.`);
        return;
      }
    } catch (error) {
      if (i === attempts) {
        throw new Error(`Health check falhou em ${url}: ${error.message}`);
      }
    }

    await sleep(delayMs);
  }

  throw new Error(`Health check falhou em ${url}.`);
}

function restoreBackup(backupDir, projectRoot, managedPaths) {
  log('Iniciando rollback a partir do backup...');
  for (const rel of managedPaths) {
    const backupPath = path.join(backupDir, rel);
    const targetPath = path.join(projectRoot, rel);

    if (fs.existsSync(backupPath)) {
      // Copia sem pré-deletar para evitar EPERM em diretórios com arquivos bloqueados
      copyPath(backupPath, targetPath);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check-only');
  const force = args.has('--force');

  const config = readJson(CONFIG_PATH);
  const state = readJson(VERSION_PATH);
  const nowIso = new Date().toISOString();

  ensureDir(config.backupDir);
  ensureDir(config.tempDir);

  state.lastCheckAt = nowIso;
  writeJson(VERSION_PATH, state);

  log(`Versão local atual: ${state.currentVersion}`);
  log(`Consultando release em ${config.githubOwner}/${config.githubRepo}...`);

  const release = await fetchLatestRelease(config);
  const remoteVersion = normalizeVersion(release.tag_name || release.name || '0.0.0');

  log(`Versão remota encontrada: ${remoteVersion}`);

  if (!force && compareVersions(remoteVersion, state.currentVersion) <= 0) {
    log('Nenhuma atualização necessária.');
    state.lastStatus = 'up-to-date';
    state.lastReleaseTag = release.tag_name || null;
    writeJson(VERSION_PATH, state);
    return;
  }

  if (checkOnly) {
    log('Modo --check-only: atualização disponível, mas nada foi alterado.');
    state.lastStatus = 'update-available';
    state.lastReleaseTag = release.tag_name || null;
    writeJson(VERSION_PATH, state);
    return;
  }

  const tempSessionDir = path.join(config.tempDir, timestamp());
  const backupDir = path.join(config.backupDir, timestamp());
  const zipFile = path.join(tempSessionDir, 'release.zip');
  const extractDir = path.join(tempSessionDir, 'extract');

  let serviceStopped = false;
  let backupDone = false;
  let filesModified = false;

  try {
    const source = chooseDownloadSource(release, config);
    log(`Baixando pacote: ${source.name}`);
    await downloadFile(source.url, zipFile, buildGitHubHeaders(config));

    log('Extraindo pacote...');
    expandZip(zipFile, extractDir);
    const packageRoot = detectPackageRoot(extractDir);

    log('Criando backup...');
    backupManagedPaths(ROOT_DIR, backupDir, config.managedPaths);
    backupDone = true;

    serviceStopped = stopService(config.serviceName);

    log('Atualizando arquivos do projeto...');
    syncManagedPaths(packageRoot, ROOT_DIR, config.managedPaths, config.preservePaths);
    filesModified = true;

    // As views NÃO são reaplicadas aqui de propósito.
    //
    // O motor as aplica sozinho no boot, pelo driver node-firebird
    // (backend/src/motor/migrations.js) — e o serviço reinicia logo abaixo.
    // Fazer isso aqui exigiria o isql.exe, que depende da instalação e do PATH
    // do Firebird na máquina do cliente: quando ele falta, o updater lançaria
    // exceção e faria ROLLBACK de uma atualização perfeitamente boa.
    // (Era por isso que o motor anterior mantinha um .sql dummy só para
    // satisfazer esta etapa.)

    if (serviceStopped) {
      startService(config.serviceName);
    }

    await healthCheck(config.healthUrl);

    state.currentVersion = remoteVersion;
    state.lastUpdateAt = new Date().toISOString();
    state.lastStatus = 'ok';
    state.lastReleaseTag = release.tag_name || null;
    state.lastError = null;
    writeJson(VERSION_PATH, state);

    log('Atualização concluída com sucesso.');
  } catch (error) {
    warn(`Erro durante atualização: ${error.message}`);

    if (backupDone && filesModified) {
      try {
        restoreBackup(backupDir, ROOT_DIR, config.managedPaths);
      } catch (rollbackError) {
        warn(`Rollback falhou: ${rollbackError.message}`);
      }
    }

    try {
      if (config.serviceName) {
        startService(config.serviceName);
      }
    } catch (startError) {
      warn(`Falha ao subir serviço após erro: ${startError.message}`);
    }

    state.lastStatus = 'error';
    state.lastError = error.message;
    writeJson(VERSION_PATH, state);
    throw error;
  } finally {
    removePath(tempSessionDir);
  }
}

main().catch((error) => {
  const line = `[Updater][ERRO] ${error.message}`;
  console.error(line);
  writeLog(line);
  process.exit(1);
});
