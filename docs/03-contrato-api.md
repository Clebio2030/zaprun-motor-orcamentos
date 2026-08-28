# Contrato da API

Base: `https://dev.zaprun.com.br`
Autenticação: header `X-Integration-Token: zrerp_...` em **todas** as rotas.

O token é gerado no painel do ZapRun (**Integrações → ERP**) e aparece **uma
única vez** — só o hash fica no banco. Perdeu, gera outro.

---

## `GET /erp/handshake`

O Motor confirma quem é e recebe como deve trabalhar.

```json
{
  "ativo": true,
  "empresa": { "id": 4, "nome": "Freitas" },
  "erpCompanyIds": [1],
  "cronExpr": "0 8-22 * * *",
  "chunkSize": 500,
  "janelaDias": 90,
  "janelaInicialDias": 1095,
  "serverTime": "2026-08-28T03:00:00.000Z"
}
```

| Campo | Significado |
|---|---|
| `ativo` | `false` = integração pausada no painel. O Motor pula o ciclo e volta depois. |
| `erpCompanyIds` | `IDEMPRESA` que este token pode enviar. `null` = todas. |
| `cronExpr` | Ritmo do ciclo. Mudar aqui muda a frota inteira. |
| `chunkSize` | Orçamentos por POST. |
| `janelaDias` / `janelaInicialDias` | Janela do ciclo normal / da primeira carga. |

**Pausado responde 200, não erro.** O Motor precisa distinguir *"não te
conheço"* (401 → parar de insistir) de *"conheço, mas hoje não"* (voltar no
próximo ciclo).

---

## `POST /erp/orcamentos/sync`

### Requisição

```jsonc
{
  "sourceVersion": "1.0.0",
  "dataReferencia": "2026-08-28",
  "syncMode": "incremental",        // ou "full"
  "desde": "2026-05-30",
  "snapshotId": "uuid-da-entrega",   // o mesmo em todos os lotes
  "expectedTotal": 1200,             // congelado antes do 1º lote
  "chunkInfo": { "atual": 1, "total": 3 },
  "orcamentos": [
    {
      "externalId": "12345",         // OBRIGATÓRIO
      "erpCompanyId": 1,             // OBRIGATÓRIO
      "erpCompanyDoc": "12345678000190",
      "numero": "12345",
      "emitidoEm": "2026-08-20",
      "validoAte": "2026-08-30",
      "situacao": "ABERTO",
      "cliente": {
        "nome": "CONSTRUÇÃO SÃO JOSÉ LTDA",
        "documento": "12.345.678/0001-90",
        "telefone": "(11) 99999-8888",
        "email": "compras@exemplo.com.br"
      },
      "vendedor": { "codigo": "7", "nome": "JOSÉ ANTÔNIO" },
      "valorTotal": 1500.00,
      "desconto": 0,
      "valorLiquido": 1500.00,
      "itens": [
        { "codigo": "A1", "descricao": "CIMENTO CP-II 50KG",
          "quantidade": 10, "valorUnitario": 35.5, "valorTotal": 355 }
      ],
      "raw": { "QUALQUER_COLUNA_DA_VIEW": "..." }
    }
  ]
}
```

Só `externalId` e `erpCompanyId` são obrigatórios. Tudo mais é opcional, e
**`raw` guarda a linha crua inteira** — coluna que o ERP traz e ainda não tem
campo tipado no ZapRun não se perde.

Aceitamos valor em pt-BR (`"1.234,56"`) e data em `DD/MM/YYYY`.

### Resposta

```json
{
  "ok": true,
  "snapshotId": "uuid-da-entrega",
  "expectedTotal": 1200,
  "persisted": {
    "received": 500,
    "inserted": 120,
    "updated": 30,
    "unchanged": 350,
    "rejected": ["9981"],
    "motivos": ["externalId ausente"]
  }
}
```

| Campo | Significado |
|---|---|
| `received` | Quantos foram **realmente persistidos**. Não é o tamanho do array que chegou. |
| `inserted` / `updated` / `unchanged` | Novos / alterados / idênticos (detectados por hash, sem escrever). |
| `rejected` | `externalId` de cada linha recusada — **nomeados**. |
| `motivos` | Até 20 explicações, para o log do Motor. |

**`received` é o contrato de integridade.** O Motor não confia no 200: ele soma
os `received` de todos os lotes e só grava o hash se o total bater com o que
enviou. Se não bater, o próximo ciclo reenvia tudo.

### Idempotência

A chave é `(companyId, erpCompanyId, externalId)`.

Reenviar o mesmo orçamento **atualiza a linha, nunca duplica** — depois de um
timeout, de um rollback do updater, de uma reinstalação, de apagar o
`sync_state.json`. Se o conteúdo for idêntico, nem UPDATE acontece: conta como
`unchanged`.

Isso é o que dispensa staging + swap. Não há estado intermediário para gerenciar
porque não há snapshot: cada orçamento se resolve sozinho.

### Códigos

| Código | Quando | O Motor faz |
|---|---|---|
| `200` | Lote processado (mesmo com algumas linhas rejeitadas) | segue para o próximo lote |
| `401` | Token inválido ou revogado | para de insistir; precisa de token novo |
| `409` | Integração pausada no painel | volta no próximo ciclo |
| `413` | Payload acima de 5 MB | **não deveria acontecer** — o `sender.js` corta por bytes antes |
| `422` | `orcamentos` ausente ou não é lista | erro de programação, não retenta |
| `429` | Excesso de requisições | espera e retenta |
| `500` | Falha ao gravar (banco fora, lote grande demais) | **retenta** — é transitório |

> Erro de lote inteiro volta como **500 de propósito**, para o Motor retentar.
> Devolver 4xx faria ele desistir, e o dado se perderia até alguém notar.

### Limites

| Limite | Valor | Onde |
|---|---|---|
| Tamanho do corpo | **5 MB** | `bodyParser.json` global do ZapRun (`app.ts`) |
| Orçamentos por POST | 2000 | `IngestQuotesService` |
| POSTs por 15 min | 600 por token | rate limit |
| Handshake por 15 min | 120 por token | rate limit |

O limite de 5 MB é **global e roda antes das rotas** — não dá para afrouxar só
para o ERP. Por isso o `chunkSize` padrão é 500 e o `sender.js` corta também
por bytes (teto de 3 MB).

---

## `GET /erp/status`

Diagnóstico pelo lado do servidor, com o mesmo token:

```json
{
  "companyId": 4,
  "totalOrcamentos": 1834,
  "ultimoRecebido": {
    "externalId": "12345", "erpCompanyId": 1,
    "emitidoEm": "2026-08-27", "syncedAt": "2026-08-28T03:00:12.000Z"
  }
}
```

---

## Rotas do painel (sessão, não token)

Usadas pela tela, não pelo Motor. Autenticam por `isAuth`.

| Rota | O quê |
|---|---|
| `GET /erp/orcamentos` | Listagem paginada. Filtros: `situacao`, `erpCompanyId`, `de`, `ate`, `busca`, `comItens`, `pageNumber`, `pageSize` (máx. 200) |
| `GET /erp/orcamentos/resumo` | Total, última sincronização e contagem por situação |
| `GET /erp/orcamentos/:id` | Um orçamento com os itens |
| `GET /erp/tokens` | Lista os tokens (nunca o valor em claro) |
| `POST /erp/tokens` | Emite um token. **Único momento em que o valor aparece.** Só admin. |
| `PUT /erp/tokens/:id` | Pausa/retoma (`isActive`), renomeia, ajusta `erpCompanyIds`. Só admin. |
| `DELETE /erp/tokens/:id` | Revoga. Só admin. |

### Situação normalizada

`situacao` guarda o texto cru do ERP. `situacaoNormalizada` guarda a nossa
leitura, e é por ela que os filtros funcionam:

`aberto` · `aprovado` · `recusado` · `cancelado` · `expirado` · `desconhecido`

O de-para está em `backend/src/modules/erp/config/erpConfig.ts`. Situação que
não reconhecemos vira `desconhecido` — e o texto original continua em `situacao`,
então nada se perde e o de-para pode crescer depois.
