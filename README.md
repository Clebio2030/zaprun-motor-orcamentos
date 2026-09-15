# ZapRun Orçamentos — Motor

Serviço Node.js que roda **na máquina do cliente**, lê os orçamentos do ERP dele
(Firebird local) e entrega na API do ZapRun.

```
  Máquina do cliente (Windows)                          Servidor ZapRun
 ┌──────────────────────────────┐                     ┌──────────────────────┐
 │  ERP (Firebird)              │                     │                      │
 │    └── view ZAPRUN_ORCAMENTOS│                     │  POST /erp/          │
 │             ▲                │   HTTPS + token     │    orcamentos/sync   │
 │             │                │  ─────────────────► │                      │
 │  Motor (serviço Windows)     │                     │  ErpQuotes           │
 │    porta 3001, só localhost  │  ◄───────────────── │  ErpQuoteItems       │
 │                              │   GET /erp/handshake│                      │
 └──────────────────────────────┘                     └──────────────────────┘
```

## Em uma frase

De hora em hora (08h–22h), o Motor pergunta ao servidor como deve trabalhar,
lê a view de orçamentos do ERP, e envia em lotes o que mudou — conferindo, no
fim, que o servidor gravou tudo o que ele mandou.

## Documentação

| Documento | Para quê |
|---|---|
| [docs/01-arquitetura.md](docs/01-arquitetura.md) | Como funciona por dentro: componentes, ciclo, estado, updater |
| [docs/02-instalacao.md](docs/02-instalacao.md) | Instalar numa máquina nova (guia do implantador) |
| [docs/03-contrato-api.md](docs/03-contrato-api.md) | Payload, respostas, erros, idempotência |
| [docs/04-view-firebird.md](docs/04-view-firebird.md) | **O que a view do ERP precisa devolver** |
| [docs/05-release-updater.md](docs/05-release-updater.md) | Publicar versão nova para a frota |
| [CLAUDE.md](CLAUDE.md) | Princípios de quem for mexer no código |

## Estrutura

```
backend/src/
  server.js              HTTP local: /health (updater) e /status (diagnóstico)
  logger.js              log diário em backend/logs/
  ensureUpdaterSchedule.js  garante a tarefa agendada do updater
  motor/
    index.js             orquestrador: handshake → extrai → envia → confere
    firebird.js          pool de conexões com timeout
    extractor.js         consulta a view e agrupa
    mapping.js           ⟵ view → payload. O ÚNICO arquivo que muda por ERP
    encoding.js          decodificação WIN1252 (acentuação)
    sender.js            handshake, POST, retry, fatiamento por bytes
    syncState.js         watermark e hash por empresa
    migrations.js        aplica sql/views_zaprun.sql no boot
sql/views_zaprun.sql     ⟵ a view do ERP
updater/                 atualização automática via release do GitHub
nssm/                    empacota o Node como serviço do Windows
tools/simular-motor.js   testa a API sem ERP e sem Windows
INSTALAR.bat             instalador (rodar como Administrador)
```

## A família de Motores

Este é o primeiro Motor, e o desenho dele virou a base dos outros. O segundo é o
**Motor ZapRun Shop** (`../motor-zaprunshop-erp`, repo `zaprun-shop-motor`), que
lê o catálogo de produtos e alimenta a loja. Ver
[ADR-167](../docs/10-decisoes/ADR-167-motor-zaprun-shop-catalogo-do-erp-2026-09.md).

As duas instalações convivem na **mesma máquina do cliente**, então tudo que é
identidade de instalação precisa diferir:

| | Orçamentos (este) | Shop |
|---|---|---|
| Porta local | **3001** | 3002 |
| Serviço Windows | **`ZapRunOrcamentos`** | `ZapRunShop` |
| Repo de release | **`zaprun-motor-orcamentos`** | `zaprun-shop-motor` |
| `backupDir`/`tempDir` | **`c:/ZapRun/Orcamentos/…`** | `c:/ZapRun/Shop/…` |
| View | **`ZAPRUN_ORCAMENTOS`** | `ZAPRUN_SHOP` |
| Endpoint | **`/erp/orcamentos/sync`** | `/erp/produtos/sync` |

Repetir a porta faz o segundo serviço a subir morrer com `EADDRINUSE` — e o
updater do primeiro passa a fazer health check no processo errado, o que é pior
que falhar, porque ninguém percebe.

Diferença de desenho que vale saber antes de copiar daqui para lá: **o Shop não
tem janela de datas**. Catálogo não tem data de emissão, e um preço muda sem que
nenhuma coluna de data mude — lá o ciclo lê tudo e deixa o hash decidir.

## Comandos

```bash
# testes (rodam em qualquer SO, sem Firebird e sem rede)
cd backend && npm test

# testar a API sem ERP nenhum
ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js

# na máquina do cliente: ver o estado
#   http://127.0.0.1:3001/status
# forçar um ciclo agora
#   POST http://127.0.0.1:3001/sync
```

## Estado atual

O Motor está **completo e testado**, aguardando apenas a view do ERP.
Enquanto `sql/views_zaprun.sql` estiver vazio, ele sobe, responde `/health` e
loga que não há view — sem erro e sem enviar nada. Assim que a view existir,
só `sql/views_zaprun.sql` e `backend/src/motor/mapping.js` mudam.
