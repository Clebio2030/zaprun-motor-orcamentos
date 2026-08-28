# Arquitetura do Motor

## O problema que ele resolve

O ERP do cliente é um Firebird que roda **dentro da rede dele**. Não há como o
ZapRun consultá-lo de fora: sem IP fixo, sem porta aberta, sem VPN. Então
invertemos o sentido — quem inicia a conversa é a máquina do cliente.

Isso traz uma consequência que governa todo o desenho: **não temos acesso a
essas máquinas.** Nada pode exigir RDP para diagnosticar ou consertar. Por isso
existem o handshake, o `/status`, os logs nomeados e o updater automático.

## Componentes

| Peça | Papel |
|---|---|
| `backend/src/server.js` | HTTP local em `127.0.0.1:3001`. Só `/health`, `/status` e `/sync`. |
| `backend/src/motor/index.js` | O ciclo. Cron + orquestração. |
| `backend/src/motor/mapping.js` | Traduz a view do ERP no nosso payload. |
| `backend/src/motor/sender.js` | Handshake, POST, retry, fatiamento. |
| `backend/src/motor/syncState.js` | O que já foi sincronizado (`sync_state.json`). |
| `updater/updater.js` | Baixa release do GitHub, faz backup, troca, valida, reverte se der errado. |
| `nssm/` | Roda o Node como serviço do Windows. |

## O ciclo

```
  cron (de hora em hora, 08h–22h)
        │
        ├─ 1. GET /erp/handshake ────────────► servidor devolve a config de frota
        │      { ativo, cronExpr, chunkSize, janelaDias, erpCompanyIds }
        │
        ├─ 2. calcula a janela de datas
        │      empresa nova  → janelaInicialDias (3 anos)
        │      já conhecida  → janelaDias (90 dias)
        │
        ├─ 3. SELECT na view ZAPRUN_ORCAMENTOS (uma consulta só)
        │      agrupa por (IDEMPRESA, ID_ORCAMENTO)
        │
        ├─ 4. para cada empresa do ERP:
        │        hash mudou? ──não──► pula (não gasta rede nem banco)
        │              │ sim
        │              ▼
        │        POST /erp/orcamentos/sync em lotes ordenados
        │        (lote N+1 só depois do 200 no N; para no primeiro erro)
        │
        └─ 5. confere: recebidos == enviados?
                 sim ──► grava o hash
                 não ──► NÃO grava. O próximo ciclo reenvia tudo.
```

### Por que a extração é uma consulta só

A view do ERP costuma ser cara. Uma consulta por empresa multiplicaria a
varredura na base do cliente pelo número de empresas. Extraímos com a janela
mais larga entre as empresas e recortamos cada uma na memória.

### Por que só grava o hash no fim

O hash é o carimbo de *"isto já chegou inteiro do outro lado"*. Gravá-lo antes
da confirmação faria o Motor **esquecer** dado que a API nunca recebeu — e nada
o traria de volta, porque o ciclo seguinte veria "nada mudou".

## Configuração: `.env` × handshake

Esta separação é a regra mais importante do projeto.

| | `.env` (na máquina) | Handshake (do servidor) |
|---|---|---|
| **O quê** | credencial, caminho do banco, token, porta | ritmo do cron, tamanho do lote, janelas, ativo/pausado, empresas autorizadas |
| **Muda como** | manualmente, uma vez, na instalação | sozinho, no próximo ciclo, para a frota inteira |

**O `.env` está em `preservePaths` do updater** — ele nunca é sobrescrito numa
atualização. Ótimo para credencial (não se perde), péssimo para config: um
valor colocado ali **nunca mais muda sozinho**. Se o ritmo do cron morasse no
`.env`, mudá-lo em 100 clientes exigiria 100 acessos remotos.

Por isso: `.env` = o que é daquela máquina. Handshake = o que é decisão nossa.

## Estado (`backend/sync_state.json`)

```json
{
  "1": { "hash": "a3f...", "lastSyncedAt": "2026-08-27T14:00:00.000Z" },
  "2": { "hash": "9c1...", "lastSyncedAt": "2026-08-27T14:00:03.000Z" }
}
```

Uma entrada por `IDEMPRESA`. Ausente = nunca sincronizou → janela inicial.

- Gravado de forma **atômica** (escreve `.tmp` e renomeia). Sem isso, uma queda
  de energia no meio da escrita deixaria um JSON truncado, e o Motor recarregaria
  3 anos de orçamento no boot seguinte.
- Arquivo corrompido é tratado como vazio: o serviço sobe e reconstrói.
- **Apagar o arquivo força uma recarga completa.** É o botão de "reprocessa tudo",
  e é seguro — o servidor deduplica por `externalId`.

O hash ignora o campo `raw`, que carrega colunas voláteis do ERP (timestamps de
log, contadores). Incluí-lo faria todo ciclo parecer alteração.

## Encoding (WIN1252)

Bases Firebird antigas guardam texto em campos `CHARACTER SET NONE` com bytes
WIN1252. O driver `node-firebird` decodifica campos `NONE` como UTF-8, e cada
byte acentuado vira `U+FFFD` — **perda irreversível na leitura**.

A solução tem duas metades, e as duas precisam existir:

1. a view entrega texto como `CAST(campo AS VARCHAR(n) CHARACTER SET OCTETS)`,
   o que faz o driver devolver um `Buffer` com os bytes crus;
2. `motor/encoding.js` decodifica esse Buffer como WIN1252.

Se um acento sair errado, o problema é a **view** (faltou o `CAST`), não o código.

## Updater

Tarefa agendada do Windows, 08:00 e 19:00:

1. consulta `releases/latest` de `Clebio2030/zaprun-motor-orcamentos`
2. compara com `updater/version.json`
3. se houver versão nova: baixa, faz backup, para o serviço, troca os arquivos
   de `managedPaths`, sobe o serviço, chama `/health`
4. **health check falhou → rollback automático** (restaura o backup)

A versão vem da **tag da release**, não do `version.json` (esse é só estado local).

O updater **não** aplica as views: quem faz isso é o próprio Motor no boot, pelo
driver do Node. Fazer isso no updater exigiria o `isql.exe`, que depende da
instalação e do PATH do Firebird na máquina — quando falta, o updater lançaria
exceção e reverteria uma atualização perfeitamente boa.

`ensureUpdaterSchedule.js` roda a cada boot do serviço e garante que a tarefa
agendada exista com os horários certos. Ele vive no **backend** (que é
atualizado) e não no `updater/` (que é preservado) — é a única peça que chega ao
cliente por release *e* roda sozinha.

## Diagnóstico sem RDP

| Onde | O que responde |
|---|---|
| `http://127.0.0.1:3001/status` | versão, último ciclo, estado do Firebird, prefixo do token, `sync_state` |
| `backend/logs/zaprun-AAAA-MM-DD.log` | tudo, com prefixo `[ZapRun]` |
| `GET /erp/status` (servidor) | quantos orçamentos daquela empresa chegaram, e quando |
| `updater/updater.log` | histórico de atualização |

Casos que o log distingue sozinho, em vez de dizer só "nenhum orçamento":

- view não existe ou está vazia
- o token autoriza a empresa 1, mas a view só tem a 3
- linhas descartadas por falta de `IDEMPRESA`/`ID_ORCAMENTO`
- orçamentos rejeitados pelo servidor, **nomeados**

## Decisões que valem explicar

**Sem staging + swap.** O motor anterior entregava *snapshot* (a tabela inteira
do período), então precisava de tabela de staging e troca atômica para não
deixar dado pela metade visível. Orçamento é *stream de upsert*: a chave
`(companyId, erpCompanyId, externalId)` faz o reenvio atualizar em vez de
duplicar. Isso elimina a peça mais frágil do desenho antigo.

**Lote de 500, com corte por bytes.** O ZapRun tem `bodyParser.json({ limit:
'5mb' })` **global**, que roda antes de qualquer rota — um parser por-rota não
resolveria. A contagem sozinha não prevê o tamanho: um orçamento com 300 itens
pesa o que 200 simples pesam. Por isso o `sender.js` corta também por bytes.

**Um item maior que o teto vai sozinho no lote, nunca truncado.** Cortar seria
perder dado. Melhor a API recusar um caso identificável.

**Sem `/companies`.** O motor anterior pedia a lista de CNPJs ativos e cruzava
com o Firebird para achar o `IDEMPRESA`. Aqui o token já identifica a empresa do
ZapRun, e `erpCompanyIds` no token diz quais empresas do ERP ele pode enviar —
duas peças a menos e uma fonte de erro a menos.
