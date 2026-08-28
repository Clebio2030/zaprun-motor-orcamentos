# Release e updater

## Como a frota recebe código novo

Nenhuma atualização é feita à mão na máquina do cliente. O caminho é sempre:

```
  commit no master
        │
        ├─ git tag vX.Y.Z  +  push
        │
        ├─ publicar a Release no GitHub   ← a tag sozinha NÃO basta
        │
        └─ updater do cliente (08:00 / 19:00)
              ├─ compara com updater/version.json
              ├─ baixa o zipball da release
              ├─ BACKUP de managedPaths
              ├─ para o serviço → troca os arquivos → sobe o serviço
              ├─ GET /health
              │     ok    → grava a versão nova
              │     falhou → ROLLBACK (restaura o backup)
              └─ o Motor, ao subir, reaplica sql/views_zaprun.sql
```

A **versão vem da tag da release**, não do `version.json` — esse é só o estado
local de cada cliente.

## Publicar uma versão

### 1. Código no `master`

Não commite runtime: `backend/.env`, `backend/sync_state.json`, `backend/logs/`,
`updater/version.json`, `updater/backups/`. O `.gitignore` já cobre.

### 2. Tag (semver, maior que a atual)

```bash
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
```

### 3. Publicar a Release

**Pelo navegador:**
`https://github.com/Clebio2030/zaprun-motor-orcamentos/releases/new?tag=v1.0.1`
→ Title `v1.0.1` → notas → **Publish release**.

Não precisa anexar `.zip`: sem asset, o updater usa o zipball da tag. Se anexar
um `.zip`, ele tem prioridade.

> Se a rede bloquear `api.github.com` (git funciona, a API não), faça o push e a
> tag normalmente e publique a Release pelo navegador. Só a criação do objeto
> Release precisa da API.

### 4. Validar num cliente antes da frota

Escolha um cliente, force e acompanhe:

```bat
schtasks /run /tn "ZapRunOrcamentosUpdater"
```

`updater\version.json` → `lastStatus` tem que virar `ok`. Depois confira
`http://127.0.0.1:3001/status` e o painel do ZapRun.

Só então deixe a frota puxar sozinha nos horários normais.

## O que é atualizado e o que é preservado

| `managedPaths` (atualizados) | `preservePaths` (nunca tocados) |
|---|---|
| `backend/` | `backend/.env` |
| `sql/` | `backend/sync_state.json` |
| `INSTALAR.bat` | `backend/logs/` |
| `instalar_servico.bat` | `backend/node_modules/` |
| `deletar_servico.bat` | `.git` |
| `ADICIONAR_INSTANCIA.bat` | |

**`updater/` não está em `managedPaths`** — o updater não se atualiza sozinho.
É proposital: uma release com updater quebrado deixaria a frota inteira sem
caminho de volta.

Consequência importante: **mudança que precisa chegar a quem já está instalado
tem de morar no `backend/`**. É por isso que `ensureUpdaterSchedule.js` (que
corrige os horários da tarefa agendada) vive no backend e roda a cada boot —
é a única peça que chega por release *e* roda sozinha.

## Mudar a view do ERP

`sql/` está em `managedPaths`, então:

1. edite `sql/views_zaprun.sql` (sempre `CREATE OR ALTER VIEW`)
2. publique a release
3. o updater troca o arquivo e reinicia o serviço
4. o Motor reaplica as views no boot

**O updater não aplica SQL.** Fazer isso ali exigiria o `isql.exe`, que depende
da instalação e do PATH do Firebird na máquina — quando falta, o updater
lançaria exceção e reverteria uma atualização boa. (Era por isso que o motor
anterior mantinha um `.sql` dummy só para satisfazer essa etapa.)

## Mudar o comportamento SEM release

Ritmo do cron, tamanho do lote, janelas, pausar um cliente, mudar o escopo de
empresas: tudo isso vem do **handshake**, decidido no servidor.

- Config da frota: `backend/src/modules/erp/config/erpConfig.ts` no ZapRun
- Por cliente: o token no painel (`isActive`, `erpCompanyIds`)

Vale para qualquer comportamento novo: prefira **default no código + toggle
server-side** a uma variável no `.env` — o `.env` é preservado e não propaga.

## Rollback

Automático quando o health check falha depois do update.

Manual, se precisar: os backups ficam em `updater/backups/<timestamp>/`. Pare o
serviço, restaure a pasta, suba o serviço.

## Diagnóstico

| Arquivo | O quê |
|---|---|
| `updater/updater.log` | histórico de todas as execuções |
| `updater/version.json` | `currentVersion`, `lastCheckAt`, `lastStatus`, `lastError` |
| `backend/logs/zaprun-*.log` | o Motor em si |

`lastStatus` possíveis: `ok`, `up-to-date`, `never-run`, ou erro com
`lastError` preenchido.
