/* =============================================================================
   ZapRun — carteira de clientes do ERP (Firebird / Automec · MIAUTOMEC)

   Base: a view REATIVANDO_CLIENTES, especificada pelo dono em 05/11/2026 para
   a Zé Grande. Esta é a versão que o MOTOR lê, com nome próprio. Diferenças:

   • Nome ZAPRUN_CLIENTES, e não REATIVANDO_CLIENTES
     A REATIVANDO_CLIENTES é do cliente: a equipe dele consulta essa view direto
     no ERP. Se o Motor usasse o mesmo nome, o CREATE OR ALTER daqui trocaria a
     view dele pela nossa, com colunas OCTETS que a ferramenta dele mostra como
     bytes. Cada um com a sua.

   • Aplicada SÓ quando a empresa liga "Reativar Clientes" no ZapRun
     Fica fora de views_zaprun.sql de propósito. Aquele arquivo roda em todo
     boot, em toda a frota; este só roda quando o handshake diz que a empresa
     usa o recurso. Um ERP sem SAIDAESTOQUE não ganha erro no log, e ninguém
     ganha uma view que não pediu.

   • SEM DIAS_SEM_COMPRAR, FAIXA_INATIVIDADE e STATUS_REATIVACAO
     As três dependem de CURRENT_DATE: mudam TODO DIA para TODOS os clientes,
     sem que nada tenha acontecido. O Motor só envia o cliente que mudou (hash
     por linha); com elas, os 50 mil mudariam todo dia e o envio incremental
     viraria carga completa diária. A faixa é calculada no ZapRun a partir de
     DT_ULTIMA_COMPRA, com as MESMAS fronteiras da especificação (30, 60, 90,
     180, 365 dias).

   • Última compra calculada de SAIDAESTOQUE (STATUS IN (1, 3)), NUNCA de
     CLIENTE.DTULTCOMPRA. Mesma regra da especificação: o campo do cadastro só
     é atualizado pela trigger de INSERT, e a venda aberta no balcão e ligada ao
     cliente por UPDATE não mexe nele (198 clientes com compra e data nula,
     2.013 com data velha, na Zé Grande).

   • IDEMPRESA_CADASTRO (C.IDEMPRESA) nas duas partes
     Loja onde o cliente foi cadastrado. Para quem nunca comprou é a única loja
     que existe; para quem comprou, a da última compra continua em
     IDEMPRESA_ULTIMA_COMPRA.

   • CHARACTER SET OCTETS em toda coluna de texto
     As colunas são CHARACTER SET NONE com bytes WIN1252. Sem o CAST o driver
     lê como UTF-8 e todo acento vira U+FFFD, com perda irreversível.

     Os tamanhos são GENEROSOS e não foram conferidos contra o catálogo do
     cliente. CAST maior que a coluna é seguro; MENOR derruba a leitura inteira
     com "string right truncation". Para conferir:
       GET http://127.0.0.1:3020/diagnostico/colunas?tabelas=CLIENTE,SAIDAESTOQUE,MUNICIPIO,VENDEDOR,CONFIGURACAO

   • Sem COMMIT WORK e sem ";" dentro do corpo
     O Motor separa os comandos por ";" (motor/migrations.js). Uma view com
     ";" no meio quebraria nesse split.

   Precisa de Firebird 3 ou mais novo (ROW_NUMBER e CTE).
   ========================================================================== */

CREATE OR ALTER VIEW ZAPRUN_CLIENTES (
    CDCLIENTE,
    IDEMPRESA_CADASTRO,
    CLIENTE,
    RAZAO,
    CPFCNPJ,
    TELEFONE,
    CELULAR,
    TELEFONE2,
    EMAIL,
    ENDERECO,
    NUMERO,
    BAIRRO,
    SUBBAIRRO,
    CIDADE,
    UF,
    CEP,
    DTCADASTRO,
    DT_PRIMEIRA_COMPRA,
    DT_ULTIMA_COMPRA,
    TOTAL_PEDIDOS,
    VALOR_TOTAL_HISTORICO,
    NRPEDIDO_ULTIMA_COMPRA,
    VALOR_ULTIMA_COMPRA,
    IDEMPRESA_ULTIMA_COMPRA,
    NOME_EMPRESA_ULTIMA_COMPRA,
    CDVENDEDOR_ULTIMA_COMPRA,
    VENDEDOR_ULTIMA_COMPRA,
    CDVENDEDOR_RESPONSAVEL,
    VENDEDOR_RESPONSAVEL,
    STATUS_CADASTRO
) AS
WITH RESUMO_COMPRAS AS (
    SELECT
        SE.CDCLIENTE,
        COUNT(DISTINCT SE.NRPEDIDO) AS TOTAL_PEDIDOS,
        SUM(SE.VLTOTAL)             AS VALOR_TOTAL_HISTORICO,
        MIN(SE.DTSAIDA)             AS DT_PRIMEIRA_COMPRA,
        MAX(SE.DTSAIDA)             AS DT_ULTIMA_COMPRA
    FROM SAIDAESTOQUE SE
    WHERE SE.STATUS IN (1, 3)
      AND SE.CDCLIENTE IS NOT NULL
    GROUP BY SE.CDCLIENTE
),
ULTIMO_PEDIDO AS (
    SELECT
        SE.CDCLIENTE,
        SE.NRPEDIDO,
        SE.IDEMPRESA,
        SE.CDVENDEDOR,
        SE.VLTOTAL,
        ROW_NUMBER() OVER (PARTITION BY SE.CDCLIENTE ORDER BY SE.DTSAIDA DESC, SE.NRPEDIDO DESC) AS RN
    FROM SAIDAESTOQUE SE
    WHERE SE.STATUS IN (1, 3)
      AND SE.CDCLIENTE IS NOT NULL
)
/* PARTE 1: clientes que já compraram */
SELECT
    C.CDCLIENTE,
    C.IDEMPRESA,
    CAST(C.CLIENTE    AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.RAZAO      AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.CGC        AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(C.TELEFONE   AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.CELULAR    AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.TELEFONE2  AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.EMAIL      AS VARCHAR(250) CHARACTER SET OCTETS),
    CAST(C.ENDERECO   AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.NUMERO     AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(C.BAIRRO     AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(C.SUBBAIRRO  AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(M.MUNICIPIO  AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(COALESCE(C.UF, M.UF) AS VARCHAR(10) CHARACTER SET OCTETS),
    CAST(C.CEP        AS VARCHAR(20)  CHARACTER SET OCTETS),
    C.CADASTRO,
    CAST(RC.DT_PRIMEIRA_COMPRA AS TIMESTAMP),
    CAST(RC.DT_ULTIMA_COMPRA   AS TIMESTAMP),
    CAST(RC.TOTAL_PEDIDOS         AS INTEGER),
    CAST(RC.VALOR_TOTAL_HISTORICO AS NUMERIC(18,2)),
    CAST(UP.NRPEDIDO  AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(UP.VLTOTAL   AS NUMERIC(18,2)),
    UP.IDEMPRESA,
    CAST(CF.NOMEEMPRESA AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(UP.CDVENDEDOR  AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(V.VENDEDOR     AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(C.CDVENDEDOR   AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(VR.VENDEDOR    AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(CASE WHEN COALESCE(C.INATIVO, 0) = -1 THEN 'INATIVO' ELSE 'ATIVO' END
         AS VARCHAR(10) CHARACTER SET OCTETS)
FROM RESUMO_COMPRAS RC
JOIN ULTIMO_PEDIDO UP ON UP.CDCLIENTE = RC.CDCLIENTE AND UP.RN = 1
JOIN CLIENTE C        ON C.CDCLIENTE  = RC.CDCLIENTE
LEFT JOIN MUNICIPIO M     ON M.CDMUNICIPIO = C.CDMUNICIPIO
LEFT JOIN CONFIGURACAO CF ON CF.IDEMPRESA  = UP.IDEMPRESA
LEFT JOIN VENDEDOR V      ON V.CDVENDEDOR  = UP.CDVENDEDOR
LEFT JOIN VENDEDOR VR     ON VR.CDVENDEDOR = C.CDVENDEDOR
UNION ALL
/* PARTE 2: clientes que nunca compraram */
SELECT
    C.CDCLIENTE,
    C.IDEMPRESA,
    CAST(C.CLIENTE    AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.RAZAO      AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.CGC        AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(C.TELEFONE   AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.CELULAR    AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.TELEFONE2  AS VARCHAR(40)  CHARACTER SET OCTETS),
    CAST(C.EMAIL      AS VARCHAR(250) CHARACTER SET OCTETS),
    CAST(C.ENDERECO   AS VARCHAR(200) CHARACTER SET OCTETS),
    CAST(C.NUMERO     AS VARCHAR(30)  CHARACTER SET OCTETS),
    CAST(C.BAIRRO     AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(C.SUBBAIRRO  AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(M.MUNICIPIO  AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(COALESCE(C.UF, M.UF) AS VARCHAR(10) CHARACTER SET OCTETS),
    CAST(C.CEP        AS VARCHAR(20)  CHARACTER SET OCTETS),
    C.CADASTRO,
    CAST(NULL AS TIMESTAMP),
    CAST(NULL AS TIMESTAMP),
    CAST(0    AS INTEGER),
    CAST(0    AS NUMERIC(18,2)),
    CAST(NULL AS VARCHAR(30) CHARACTER SET OCTETS),
    CAST(NULL AS NUMERIC(18,2)),
    CAST(NULL AS INTEGER),
    CAST(CF.NOMEEMPRESA AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(NULL AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(NULL AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(C.CDVENDEDOR   AS VARCHAR(20)  CHARACTER SET OCTETS),
    CAST(VR.VENDEDOR    AS VARCHAR(100) CHARACTER SET OCTETS),
    CAST(CASE WHEN COALESCE(C.INATIVO, 0) = -1 THEN 'INATIVO' ELSE 'ATIVO' END
         AS VARCHAR(10) CHARACTER SET OCTETS)
FROM CLIENTE C
LEFT JOIN MUNICIPIO M     ON M.CDMUNICIPIO = C.CDMUNICIPIO
LEFT JOIN CONFIGURACAO CF ON CF.IDEMPRESA  = C.IDEMPRESA
LEFT JOIN VENDEDOR VR     ON VR.CDVENDEDOR = C.CDVENDEDOR
WHERE NOT EXISTS (
    SELECT 1 FROM SAIDAESTOQUE SE
    WHERE SE.CDCLIENTE = C.CDCLIENTE
      AND SE.STATUS IN (1, 3)
);
