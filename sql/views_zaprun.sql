/* =============================================================================
   ZapRun Orçamentos — view do ERP (Firebird / miautomec)

   Aplicada AUTOMATICAMENTE pelo Motor a cada boot do serviço.
   Por isso é sempre CREATE OR ALTER VIEW, nunca CREATE VIEW.

   Escrita a partir do schema REAL do ERP, lido por GET /diagnostico/colunas —
   não da descrição de ninguém. Cada CAST usa o tamanho declarado da coluna:
   um CAST menor que o dado NÃO trunca em silêncio, ele derruba a leitura
   inteira com "string right truncation", e o ciclo não entrega nada.

   Decisões que valem explicar:

   • SEM `WHERE o.STATUS = 0`
     O SELECT original só devolvia orçamento aberto. Quando um orçamento é
     fechado, ele SOME da view — e como o sync é um fluxo de upsert sem
     exclusão, ele congelaria como "aberto" para sempre no ZapRun, com o
     follow-up cobrando uma venda já encerrada. A situação vem como coluna.

   • STATUS 0 = aberto, 1 = fechado (INTEGER, confirmado no catálogo).
     "Fechado" não é traduzido para "aprovado": este ERP não distingue venda
     ganha de perdida, e afirmar aprovação que ninguém informou falsearia
     qualquer relatório de conversão.

   • LEFT JOIN em tudo
     Com INNER JOIN, orçamento sem item — ou com vendedor nulo — desaparecia
     por completo.

   • O JOIN de ORCPROD inclui IDEMPRESA
     ORCPROD tem IDEMPRESA e sua chave é (POSIC, NRORCAMENTO, IDEMPRESA).
     Juntar só por NRORCAMENTO faria os itens da empresa 1 aparecerem no
     orçamento de mesmo número da empresa 2.

   • Telefone com COALESCE
     O follow-up precisa de um número que atenda. A ordem é a que mais tem
     chance de ser WhatsApp: o cadastro do cliente primeiro, o que foi digitado
     no orçamento por último.

   • CHARACTER SET OCTETS em toda coluna de texto
     As colunas são CHARACTER SET NONE com bytes WIN1252. Sem o CAST, o driver
     as lê como UTF-8 e todo acento vira U+FFFD, com perda irreversível.
   ========================================================================== */

CREATE OR ALTER VIEW ZAPRUN_ORCAMENTOS (
    IDEMPRESA, ID_ORCAMENTO, NUMERO, DTEMISSAO, SITUACAO,
    CLIENTE, CLIENTE_DOC, CLIENTE_FONE, CLIENTE_EMAIL, CLIENTE_COD,
    VENDEDOR_COD, VENDEDOR, VENDEDOR_FONE,
    VL_TOTAL, VL_DESCONTO,
    CNPJ, NOMEEMPRESA, CONTATO, OBSERVACAO,
    ITEM_CODIGO, ITEM_DESCRICAO, ITEM_UNIDADE,
    ITEM_QTD, ITEM_VL_UNIT, ITEM_VL_TOTAL
) AS
SELECT
    o.IDEMPRESA,
    CAST(o.NRORCAMENTO AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(o.NRORCAMENTO AS VARCHAR(30)  CHARACTER SET OCTETS),
    o.DTORC,
    CASE o.STATUS
      WHEN 0 THEN CAST('ABERTO'  AS VARCHAR(20) CHARACTER SET OCTETS)
      WHEN 1 THEN CAST('FECHADO' AS VARCHAR(20) CHARACTER SET OCTETS)
      ELSE CAST(o.STATUS AS VARCHAR(20) CHARACTER SET OCTETS)
    END,
    CAST(o.CLIENTE     AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(cli.CGC       AS VARCHAR(15)  CHARACTER SET OCTETS),
    CAST(COALESCE(cli.WHATSAPP, cli.CELULAR, o.TELEFONE, cli.TELEFONE)
                       AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(cli.EMAIL     AS VARCHAR(250) CHARACTER SET OCTETS),
    o.CDCLIENTE,
    CAST(o.CDVENDEDOR  AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(v.VENDEDOR    AS VARCHAR(50)  CHARACTER SET OCTETS),
    CAST(COALESCE(v.CELULAR, v.TELEFONE) AS VARCHAR(15) CHARACTER SET OCTETS),
    o.VLTOTAL,
    o.DESCONTO,
    CAST(c.CNPJ        AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(c.NOMEEMPRESA AS VARCHAR(60)  CHARACTER SET OCTETS),
    CAST(o.CONTATO     AS VARCHAR(70)  CHARACTER SET OCTETS),
    CAST(o.OBSERVACAO  AS VARCHAR(255) CHARACTER SET OCTETS),
    CAST(op.CDPRODUTO  AS VARCHAR(10)  CHARACTER SET OCTETS),
    CAST(op.DESCRICAO  AS VARCHAR(150) CHARACTER SET OCTETS),
    CAST(op.UNID       AS VARCHAR(3)   CHARACTER SET OCTETS),
    op.QTDPRODUTO,
    op.VLUNIT,
    op.TOTAL
FROM ORCAMENTO o
LEFT JOIN ORCPROD      op ON op.NRORCAMENTO = o.NRORCAMENTO
                         AND op.IDEMPRESA   = o.IDEMPRESA
LEFT JOIN VENDEDOR      v ON v.CDVENDEDOR   = o.CDVENDEDOR
LEFT JOIN CONFIGURACAO  c ON c.IDEMPRESA    = o.IDEMPRESA
LEFT JOIN CLIENTE     cli ON cli.CDCLIENTE  = o.CDCLIENTE
                         AND cli.IDEMPRESA  = o.IDEMPRESA;
