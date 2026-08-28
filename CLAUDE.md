# ZapRun Orçamentos — instruções para IA (Claude e demais)

Este repo é o **Motor ZapRun Orçamentos**: serviço Node.js que roda na máquina
de cada cliente, lê os orçamentos do ERP dele (Firebird local) e entrega na API
do ZapRun via `POST /erp/orcamentos/sync`.

## ⚠️ Leia primeiro

1. **[docs/01-arquitetura.md](docs/01-arquitetura.md)** — componentes, ciclo,
   estado, updater, e o porquê de cada decisão.
2. **[docs/03-contrato-api.md](docs/03-contrato-api.md)** — payload, respostas,
   idempotência, limites.
3. **[docs/04-view-firebird.md](docs/04-view-firebird.md)** — o contrato da view.

O lado servidor vive em outro repo: `zaprun3.0`, em
`backend/src/modules/erp/`. Mudança de contrato mexe nos dois.

## Princípios não-negociáveis

**Pense em 100+ clientes, zero trabalho manual por máquina.**
Config de frota **nunca** no `.env` — ele é preservado no update e não propaga.
Use default no código ou toggle server-side (handshake). O `.env` guarda só
credencial, caminho e token.

**Sem perda de dado. "A qualidade é o dado."**
Falha tem de ser fail-safe: nunca deixar estado parcial nem descartar linha em
silêncio. Linha ruim é **contada e nomeada** no log. Idempotência em tudo.

**Nunca confie só no `200`.**
A entrega só está confirmada quando `persisted.received` bate com o
`expectedTotal`. Gravar o hash antes disso faz o Motor esquecer dado que a API
nunca recebeu — e nada o traz de volta.

**Retrocompatibilidade + canário.**
Motor e API atualizam em ritmos diferentes. Payload novo tem de ser inofensivo
para a versão antiga da API, e vice-versa. Valide num cliente antes da frota.

**Observável de fora.**
Ninguém tem RDP nessas máquinas. Log estruturado, `/status`, e mensagens que
digam o que fazer — não "erro 400", mas "o token autoriza a empresa 1, mas a
view só tem [3]".

## Ao trabalhar aqui

- **Trocar de ERP = trocar `sql/views_zaprun.sql` + `motor/mapping.js`.** Se uma
  mudança de ERP encostar em `index.js`, `sender.js` ou `syncState.js`, o
  desenho vazou — repense.
- `.env` e `sync_state.json` são preservados no update. Não dependa deles para
  propagar mudança.
- Rode os testes: `cd backend && npm test` (rodam sem Firebird e sem rede).
- Teste a API sem ERP: `ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js`.
- **Encoding (WIN1252/OCTETS) é trilha própria.** Não misture com outra mudança
  no mesmo commit — foi caro de acertar e é fácil de regredir.
- Os `.bat` precisam de CRLF (`.gitattributes` cuida). Com LF puro o `cmd.exe`
  quebra em labels e blocos, e o instalador fecha sozinho no meio.

## Armadilhas conhecidas

| Armadilha | Consequência |
|---|---|
| Aumentar `chunkSize` sem medir | 413 — o ZapRun tem `bodyParser.json({limit:'5mb'})` **global**, antes das rotas |
| Aplicar SQL pelo updater | Exige `isql.exe`; quando falta, reverte atualização boa |
| Coluna de texto sem `CHARACTER SET OCTETS` na view | Acentuação perdida **irreversivelmente** na leitura |
| Incluir `raw` no hash | Todo ciclo parece alteração (colunas voláteis do ERP) |
| Gravar o hash antes de conferir `received` | Perda silenciosa de dado |
| Mexer em `updater/` esperando que chegue aos clientes | `updater/` não está em `managedPaths` — não se atualiza sozinho |

## Release

Código chega na frota por **release no GitHub**
(`Clebio2030/zaprun-motor-orcamentos`, `releases/latest`); os clientes puxam
pelo updater às 08h/19h. Ver [docs/05-release-updater.md](docs/05-release-updater.md).

Ativação de comportamento por cliente = **toggle server-side**, nunca `.env`.
