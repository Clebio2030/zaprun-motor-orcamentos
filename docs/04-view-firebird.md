# A view do ERP — contrato

> Este é o documento que fecha a Fase 1. O Motor está pronto; falta a view.
> Quando ela existir, mudam **dois arquivos**: `sql/views_zaprun.sql` e
> (se os nomes das colunas forem outros) `backend/src/motor/mapping.js`.

## O que precisa existir

Uma view chamada `ZAPRUN_ORCAMENTOS` no Firebird do cliente.

Ela pode ter **uma linha por orçamento** ou **uma linha por item** (com o
cabeçalho repetido). Os dois formatos funcionam: o Motor agrupa por
`(IDEMPRESA, ID_ORCAMENTO)` e monta a lista de itens.

## Colunas

### Obrigatórias

Sem estas duas, a linha é **descartada** (e contada no log — nunca some em
silêncio).

| Coluna | Tipo | Vira | Por quê |
|---|---|---|---|
| `IDEMPRESA` | INTEGER | `erpCompanyId` | Uma base costuma ter várias empresas. Também é o recorte de autorização do token. |
| `ID_ORCAMENTO` | texto | `externalId` | **A chave de idempotência.** É por ela que o reenvio atualiza em vez de duplicar. Precisa ser estável: o mesmo orçamento tem que trazer o mesmo valor sempre. |

### Opcionais

Ausência não quebra nada — o campo fica `null`.

| Coluna | Tipo | Vira |
|---|---|---|
| `NUMERO` | texto | número do orçamento mostrado ao usuário |
| `DTEMISSAO` | DATE | `emitidoEm` — **é a coluna da janela de datas** |
| `DTVALIDADE` | DATE | `validoAte` |
| `SITUACAO` | texto | `situacao` (cru) + `situacaoNormalizada` (nossa leitura) |
| `CLIENTE` | texto | nome do cliente |
| `CLIENTE_DOC` | texto | CPF/CNPJ (guardamos só os dígitos) |
| `CLIENTE_FONE` | texto | telefone (só dígitos) — **insumo do follow-up da Fase 2** |
| `CLIENTE_EMAIL` | texto | e-mail |
| `VENDEDOR_COD` | texto | código do vendedor |
| `VENDEDOR` | texto | nome do vendedor |
| `VL_TOTAL` | NUMERIC | valor total |
| `VL_DESCONTO` | NUMERIC | desconto |
| `VL_LIQUIDO` | NUMERIC | valor líquido |
| `ITEM_CODIGO` | texto | código do produto |
| `ITEM_DESCRICAO` | texto | descrição do produto |
| `ITEM_QTD` | NUMERIC | quantidade |
| `ITEM_VL_UNIT` | NUMERIC | valor unitário |
| `ITEM_VL_TOTAL` | NUMERIC | valor total do item |

> Uma linha só conta como item se trouxer `ITEM_CODIGO` **ou**
> `ITEM_DESCRICAO`. Só quantidade ou só valor não bastam.

### Se a sua view tiver outros nomes

Duas saídas, e a primeira é melhor:

1. **Renomear na view** (`SELECT O.NRORC AS ID_ORCAMENTO, ...`). O contrato fica
   igual em todo cliente, e `mapping.js` nunca vira uma coleção de exceções.
2. Ajustar `backend/src/motor/mapping.js` — vale quando o ERP é outro de verdade.

## Regra que não pode ser esquecida: `CHARACTER SET OCTETS`

**Toda coluna de texto** precisa sair da view assim:

```sql
CAST(C.NOME AS VARCHAR(200) CHARACTER SET OCTETS)
```

Sem isso, "CONSTRUÇÃO" chega como "CONSTRU♦♦O" e **não há como recuperar** — a
perda acontece na leitura, antes de o dado chegar ao nosso código.

Motivo: o campo no ERP é `CHARACTER SET NONE` com bytes WIN1252, e o driver
`node-firebird` tenta lê-lo como UTF-8. Com `OCTETS`, o driver devolve os bytes
crus e `motor/encoding.js` decodifica corretamente.

Colunas **numéricas e de data não levam CAST** — só texto.

## Modelo

Está comentado em [`sql/views_zaprun.sql`](../sql/views_zaprun.sql), pronto para
descomentar e ajustar aos nomes das tabelas do ERP:

```sql
CREATE OR ALTER VIEW ZAPRUN_ORCAMENTOS (
    IDEMPRESA, ID_ORCAMENTO, NUMERO, DTEMISSAO, DTVALIDADE, SITUACAO,
    CLIENTE, CLIENTE_DOC, CLIENTE_FONE, CLIENTE_EMAIL,
    VENDEDOR_COD, VENDEDOR, VL_TOTAL, VL_DESCONTO, VL_LIQUIDO,
    ITEM_CODIGO, ITEM_DESCRICAO, ITEM_QTD, ITEM_VL_UNIT, ITEM_VL_TOTAL
) AS
SELECT
    O.IDEMPRESA,
    CAST(O.NRORCAMENTO AS VARCHAR(30)  CHARACTER SET OCTETS),
    ...
```

**Sempre `CREATE OR ALTER VIEW`**, nunca `CREATE VIEW`: o arquivo é reaplicado a
cada boot do serviço, e é assim que uma release propaga uma mudança de view para
a frota inteira.

## Como testar a view

Na máquina do cliente, depois de aplicá-la:

```sql
-- 1. Existe e responde?
SELECT COUNT(*) FROM ZAPRUN_ORCAMENTOS;

-- 2. Quais empresas ela traz? (têm de bater com o escopo do token)
SELECT DISTINCT IDEMPRESA FROM ZAPRUN_ORCAMENTOS;

-- 3. Alguma linha sem chave? O resultado tem que ser 0.
SELECT COUNT(*) FROM ZAPRUN_ORCAMENTOS
 WHERE IDEMPRESA IS NULL OR ID_ORCAMENTO IS NULL;

-- 4. Volume da janela normal (90 dias)
SELECT COUNT(*) FROM ZAPRUN_ORCAMENTOS
 WHERE DTEMISSAO >= DATEADD(-90 DAY TO CURRENT_DATE);
```

Depois, com o serviço no ar:

```
POST http://127.0.0.1:3001/sync     força um ciclo agora
GET  http://127.0.0.1:3001/status   mostra o resultado
```

E o log em `backend/logs/` dirá exatamente quantas linhas viraram quantos
orçamentos, e quantas foram descartadas e por quê.

## Enquanto a view não existe

`sql/views_zaprun.sql` está **vazio de propósito** (só comentários). O Motor
sobe, responde `/health`, loga *"views_zaprun.sql está vazio"* e não envia nada.

Isso é melhor do que uma view inventada: uma view errada entregaria dado errado
em silêncio, e o custo de descobrir isso depois é muito maior do que o de não
ter dado nenhum.
