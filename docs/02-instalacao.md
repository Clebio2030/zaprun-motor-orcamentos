# Instalação — guia do implantador

## Antes de ir até o cliente

Tenha em mãos:

1. **Token de integração** — gerado no painel do ZapRun, em **Integrações → ERP**.
   Começa com `zrerp_`. **Ele aparece uma única vez**: copie na hora.
   ⚠️ Confira que é o token da empresa certa — é ele que decide de quem é o dado.
2. **Caminho do banco Firebird** — o mesmo que está no `Start.in` do ERP.
   Ex.: `C:\Sistemas\Banco\DADOS.FDB`
3. **IP e porta do Firebird** — normalmente `127.0.0.1` e `3050`
4. **Pasta de instalação do Firebird** — onde fica o `firebird.conf`.
   Ex.: `C:\Program Files\Firebird\Firebird_5_0`

Vale testar o token antes de sair, de qualquer máquina com Node:

```bash
ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js
```

Se isso passar, a metade servidor já está de pé.

## Instalação

1. Copie o pacote para a máquina e extraia em **`C:\ZapRun\Orcamentos`**.
2. Clique com o botão direito em **`INSTALAR.bat`** → **Executar como administrador**.
   (Sem isso o script avisa e fecha — ele registra um serviço do Windows.)

São 5 passos, quase todos automáticos:

| Passo | O que acontece | O que você faz |
|---|---|---|
| **1/5** Node.js | Abre o instalador do `node.msi` | "Next" até o fim. Se a máquina já tiver Node atual, pode cancelar. |
| **2/5** Dependências | `npm install` | Esperar (alguns minutos). |
| **3/5** Ambiente | Pergunta IP, porta, caminho do banco e o token | Digitar. Enter em branco mantém o valor atual. |
| **4/5** Firebird | Faz backup do `firebird.conf` e ajusta `AuthServer`, `AuthClient`, `WireCrypt` | Informar a pasta do Firebird e responder `S` para reiniciar o serviço. |
| **5/5** Serviço | Registra `ZapRunOrcamentos` no Windows e agenda o updater (08:00 e 19:00) | Nada. |

Ao final, o instalador consulta `http://127.0.0.1:3001/status` e mostra versão,
estado do Firebird, token e API. **Leia essa tela antes de ir embora.**

> Não existe passo de "criar views": o Motor aplica `sql/views_zaprun.sql`
> sozinho a cada boot, pelo driver do Node — sem depender do `isql.exe`.

## Conferir se funcionou

No navegador **da máquina do cliente**:

```
http://127.0.0.1:3001/status
```

O que olhar:

| Campo | Esperado |
|---|---|
| `firebird` | `"ok"` |
| `token` | o prefixo do token que você colou |
| `sincronizacao` | ganha entradas depois do primeiro ciclo |
| `ultimoCiclo.enviados` | ≥ 1 quando há orçamento na janela |

Para forçar um ciclo sem esperar a próxima hora:

```
POST http://127.0.0.1:3001/sync
```

(ou, no PowerShell: `Invoke-RestMethod -Method Post http://127.0.0.1:3001/sync`)

Depois, confira no painel do ZapRun se os orçamentos chegaram.

## Mais de um banco na mesma máquina

`ADICIONAR_INSTANCIA.bat` instala uma segunda instância, com porta e serviço
próprios. Cada instância precisa do **seu** token.

## Quando dá errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "npm não é reconhecido" | PATH não recarregou depois do Node | Fechar e reabrir o `INSTALAR.bat` como Administrador |
| `firebird.conf` não encontrado | Caminho errado | Achar a pasta no Disco C:, copiar da barra de endereços e colar (botão direito cola) |
| Serviço não instala | Não rodou como Administrador | Botão direito → Executar como administrador |
| `/status` não responde | Serviço parado | `services.msc` → `ZapRunOrcamentos` → Iniciar. Ver `backend\logs\` |
| `firebird: "error"` | Banco/credencial errados | Conferir `FB_DATABASE` em `backend\.env` |
| Log: "views_zaprun.sql está vazio" | **Normal por enquanto** — a view do ERP ainda não foi escrita | Nada. Ver `docs/04-view-firebird.md` |
| Log: "Token de integração inválido" | Token errado, de outra empresa, ou revogado | Gerar outro no painel e corrigir `ZAPRUN_TOKEN` em `backend\.env` |
| Log: "o token autoriza a empresa X, mas a view só tem [Y]" | Escopo do token não bate com o ERP | Ajustar `erpCompanyIds` do token no painel |
| Acento errado ("CONSTRU♦♦O") | A view esqueceu `CHARACTER SET OCTETS` | Corrigir a view — ver `docs/04-view-firebird.md` |

Logs: `C:\ZapRun\Orcamentos\backend\logs\zaprun-AAAA-MM-DD.log`

## Atualizações

Automáticas. O updater roda às **08:00 e 19:00**, compara com a última release
do GitHub e, se houver versão nova, atualiza — com backup e **rollback
automático** se o health check falhar.

Preservados na atualização: `backend\.env`, `backend\sync_state.json`,
`backend\logs`, `backend\node_modules`.

Forçar agora:

```bat
schtasks /run /tn "ZapRunOrcamentosUpdater"
```

Acompanhar: `updater\updater.log` e `updater\version.json`.

## Desinstalar

`deletar_servico.bat` (como Administrador) remove o serviço. A pasta e os
dados no ZapRun ficam. Para cortar o acesso de vez, **revogue o token no
painel** — só isso garante que aquela máquina não envia mais nada.
