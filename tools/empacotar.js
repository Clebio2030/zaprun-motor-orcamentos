#!/usr/bin/env node
//
// Gera o ZapRunOrcamentos.zip que o cliente baixa pelo painel.
//
// Roda UMA vez por versão, não a cada download: o resultado é idêntico toda
// vez, então compactar por clique seria pagar CPU pelo mesmo arquivo. Quem
// serve o zip é o nginx, direto do disco — o Node fica fora do caminho.
//
// Uso:
//   node tools/empacotar.js                      → grava no destino padrão
//   node tools/empacotar.js /caminho/saida.zip
//
// Rode isto sempre que publicar uma versão nova do Motor.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
const DESTINO_PADRAO = "/home/deploy/downloads/ZapRunOrcamentos.zip";
const destino = process.argv[2] || DESTINO_PADRAO;

// Pasta raiz DENTRO do zip. Sem isso, extrair espalha 70 arquivos soltos na
// pasta de Downloads do implantador.
const PASTA = "ZapRunOrcamentos";

// O que NÃO vai no pacote do cliente:
//   .git            458 MB de histórico, inútil na máquina do cliente
//   node_modules    o INSTALAR.bat roda `npm install`
//   .env            credencial; o instalador pergunta e escreve
//   sync_state.json estado de outra máquina causaria sync incorreto
//   logs            log de outro cliente
//   nssm/src        código C++ do nssm; só os .exe são usados
//   tools           scripts nossos, não do cliente
const EXCLUIR = [
  /^\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /^backend\/\.env$/,
  /^backend\/sync_state\.json/,
  /^backend\/logs(\/|$)/,
  /^nssm\/src(\/|$)/,
  /^tools(\/|$)/,
  /^updater\/(backups|temp)(\/|$)/,
  /^updater\/(updater\.log|secrets\.json)$/,
  /\.zip$/,
  /(^|\/)\.DS_Store$/
];

const listar = (dir, base = "") => {
  const saida = [];
  for (const nome of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${nome}` : nome;
    if (EXCLUIR.some(r => r.test(rel))) continue;

    const abs = path.join(dir, nome);
    const st = fs.statSync(abs);
    if (st.isDirectory()) saida.push(...listar(abs, rel));
    else if (st.isFile()) saida.push(rel);
  }
  return saida;
};

const arquivos = listar(RAIZ);

if (!arquivos.includes("INSTALAR.bat")) {
  console.error("ERRO: INSTALAR.bat não entrou no pacote. Abortando.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.rmSync(destino, { force: true });

// Empacota com o zipfile do Python: gera .zip de verdade (o Windows extrai sem
// programa nenhum), sem precisar do utilitário `zip`, que não existe aqui.
// Escreve num temporário e renomeia no fim: assim o nginx nunca serve um zip
// pela metade para quem baixar durante a regeneração.
const tmp = `${destino}.tmp`;
const script = `
import sys, zipfile, os
destino, raiz, pasta = sys.argv[1], sys.argv[2], sys.argv[3]
arquivos = sys.stdin.read().split("\\n")
with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for rel in arquivos:
        if not rel: continue
        z.write(os.path.join(raiz, rel), os.path.join(pasta, rel))
`;

execFileSync("python3", ["-c", script, tmp, RAIZ, PASTA], {
  input: arquivos.join("\n")
});

fs.renameSync(tmp, destino);

const mb = (fs.statSync(destino).size / 1048576).toFixed(1);
console.log(`${destino}`);
console.log(`${arquivos.length} arquivos · ${mb} MB`);
