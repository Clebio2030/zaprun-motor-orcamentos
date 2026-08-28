/* =============================================================================
   ZapRun Orçamentos — views do ERP (Firebird)

   Este arquivo é aplicado AUTOMATICAMENTE pelo Motor a cada boot do serviço
   (backend/src/motor/migrations.js). Publicar uma release que mude este arquivo
   propaga a view para a frota inteira: o updater baixa, o serviço reinicia, a
   view é reaplicada.

   Por isso TODO comando aqui precisa ser idempotente — use sempre
   `CREATE OR ALTER VIEW`, nunca `CREATE VIEW`.

   ⚠️  ESTE ARQUIVO ESTÁ VAZIO DE PROPÓSITO.
   Enquanto a view real não existir, o Motor loga "views_zaprun.sql está vazio"
   e segue rodando. Isso é melhor do que uma view inventada: uma view errada
   entregaria dado errado silenciosamente, e "a qualidade é o dado".

   Para ativar: descomente o bloco abaixo e ajuste as tabelas do seu ERP.
   O contrato de colunas está em docs/04-view-firebird.md e o mapeamento em
   backend/src/motor/mapping.js.
   ========================================================================== */


/* -----------------------------------------------------------------------------
   ZAPRUN_ORCAMENTOS

   Uma linha por ITEM de orçamento (o cabeçalho se repete) OU uma linha por
   orçamento — os dois formatos funcionam, o Motor agrupa por
   (IDEMPRESA, ID_ORCAMENTO).

   OBRIGATÓRIAS:  IDEMPRESA, ID_ORCAMENTO
   OPCIONAIS:     todas as demais

   Toda coluna de TEXTO tem que sair com CHARACTER SET OCTETS. Sem isso, o
   node-firebird lê campos CHARACTER SET NONE como UTF-8 e todo acento vira "♦"
   — perda irreversível na leitura. Ver backend/src/motor/encoding.js.

CREATE OR ALTER VIEW ZAPRUN_ORCAMENTOS (
    IDEMPRESA,
    ID_ORCAMENTO,
    NUMERO,
    DTEMISSAO,
    DTVALIDADE,
    SITUACAO,
    CLIENTE,
    CLIENTE_DOC,
    CLIENTE_FONE,
    CLIENTE_EMAIL,
    VENDEDOR_COD,
    VENDEDOR,
    VL_TOTAL,
    VL_DESCONTO,
    VL_LIQUIDO,
    ITEM_CODIGO,
    ITEM_DESCRICAO,
    ITEM_QTD,
    ITEM_VL_UNIT,
    ITEM_VL_TOTAL
) AS
SELECT
    O.IDEMPRESA,
    CAST(O.NRORCAMENTO      AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(O.NRORCAMENTO      AS VARCHAR(30)  CHARACTER SET OCTETS),
    O.DTEMISSAO,
    O.DTVALIDADE,
    CAST(O.SITUACAO         AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.NOME             AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.CGC              AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(C.FONE             AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(C.EMAIL            AS VARCHAR(120) CHARACTER SET OCTETS),
    CAST(V.CDVENDEDOR       AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(V.NOME             AS VARCHAR(120) CHARACTER SET OCTETS),
    O.VLTOTAL,
    O.VLDESCONTO,
    O.VLLIQUIDO,
    CAST(I.CDPRODUTO        AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(P.DESCRICAO        AS VARCHAR(200) CHARACTER SET OCTETS),
    I.QUANTIDADE,
    I.VLUNITARIO,
    I.VLTOTAL
FROM ORCAMENTO O
LEFT JOIN ORCAMENTO_ITEM I ON I.NRORCAMENTO = O.NRORCAMENTO
                          AND I.IDEMPRESA   = O.IDEMPRESA
LEFT JOIN CLIENTE        C ON C.CDCLIENTE   = O.CDCLIENTE
LEFT JOIN VENDEDOR       V ON V.CDVENDEDOR  = O.CDVENDEDOR
LEFT JOIN PRODUTO        P ON P.CDPRODUTO   = I.CDPRODUTO;

----------------------------------------------------------------------------- */
