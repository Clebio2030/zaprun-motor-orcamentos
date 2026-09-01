/* =============================================================================
   ZapRun Orçamentos — view do ERP (Firebird)

   Aplicada AUTOMATICAMENTE pelo Motor a cada boot do serviço.
   Por isso é sempre CREATE OR ALTER VIEW, nunca CREATE VIEW.

   Baseada no SELECT do cliente, com três correções — cada uma testada contra
   um Firebird real (ver o histórico da conversa):

   1. SEM `WHERE o.status = 0`
      O SELECT original só devolvia orçamento aberto. Quando um orçamento é
      fechado, ele SOME da view — e o Motor nunca fica sabendo. No ZapRun a
      linha congelaria como "aberto" para sempre, e o follow-up continuaria
      cobrando uma venda já ganha ou já perdida. A situação vem como coluna e
      quem decide o que fazer com ela é o ZapRun.

   2. LEFT JOIN no lugar de INNER JOIN
      Com INNER JOIN, orçamento sem item (ou com vendedor nulo) desaparecia por
      completo — testado: o orçamento 4472 sumia da view.

   3. CAST(... CHARACTER SET OCTETS) em toda coluna de texto
      As colunas do ERP são CHARACTER SET NONE com bytes WIN1252. Sem o CAST o
      driver as lê como UTF-8 e todo acento vira U+FFFD, com perda irreversível.

   Status do ERP: 0 = aberto, 1 = fechado. "Fechado" NÃO significa ganho — este
   ERP não distingue venda ganha de perdida, então o ZapRun guarda "fechado"
   como estado próprio em vez de afirmar "aprovado".

   Colunas extras (VENDEDOR_FONE, CNPJ, OBSERVACAO, ITEM_UNIDADE, CLIENTE_COD,
   NOMEEMPRESA) não têm campo tipado no ZapRun ainda — são gravadas no JSONB
   `raw` e viram coluna quando o follow-up precisar delas.
   ========================================================================== */

CREATE OR ALTER VIEW ZAPRUN_ORCAMENTOS (
    IDEMPRESA, ID_ORCAMENTO, NUMERO, DTEMISSAO, SITUACAO,
    CLIENTE, CLIENTE_FONE, CLIENTE_COD,
    VENDEDOR_COD, VENDEDOR, VENDEDOR_FONE,
    VL_TOTAL, CNPJ, NOMEEMPRESA, OBSERVACAO,
    ITEM_CODIGO, ITEM_DESCRICAO, ITEM_UNIDADE,
    ITEM_QTD, ITEM_VL_UNIT, ITEM_VL_TOTAL
) AS
SELECT
    o.IDEMPRESA,
    CAST(o.NRORCAMENTO AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(o.NRORCAMENTO AS VARCHAR(30)  CHARACTER SET OCTETS),
    o.DTORC,
    CASE o.STATUS
      WHEN 0 THEN CAST('ABERTO'   AS VARCHAR(20) CHARACTER SET OCTETS)
      WHEN 1 THEN CAST('FECHADO'  AS VARCHAR(20) CHARACTER SET OCTETS)
      ELSE CAST(o.STATUS AS VARCHAR(20) CHARACTER SET OCTETS)
    END,
    CAST(o.CLIENTE     AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(o.TELEFONE    AS VARCHAR(20)  CHARACTER SET OCTETS),
    o.CDCLIENTE,
    CAST(o.CDVENDEDOR  AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(v.VENDEDOR    AS VARCHAR(60)  CHARACTER SET OCTETS),
    CAST(v.CELULAR     AS VARCHAR(20)  CHARACTER SET OCTETS),
    o.VLTOTAL,
    CAST(c.CNPJ        AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(c.NOMEEMPRESA AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(o.OBSERVACAO  AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(op.CDPRODUTO  AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(op.DESCRICAO  AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(op.UNID       AS VARCHAR(10)  CHARACTER SET OCTETS),
    op.QTDPRODUTO,
    op.VLUNIT,
    op.QTDPRODUTO * op.VLUNIT
FROM ORCAMENTO o
LEFT JOIN ORCPROD      op ON o.NRORCAMENTO = op.NRORCAMENTO
LEFT JOIN VENDEDOR      v ON o.CDVENDEDOR  = v.CDVENDEDOR
LEFT JOIN CONFIGURACAO  c ON o.IDEMPRESA   = c.IDEMPRESA;
