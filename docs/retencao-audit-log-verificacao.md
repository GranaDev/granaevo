# Retenção do `financial_audit_log` — verificação do mecanismo

**Data:** 2026-07-18 · **Ambiente:** produção · **Resultado:** ✅ funciona

## Por que esta verificação existia como pendência

O cron de retenção (`jobid 24`, `0 4 1 * *` → `purge_audit_log_retention()`) está ativo e roda
todo mês, mas **nunca apagou uma linha sequer** — porque nenhuma linha tinha mais de 6 meses
(a mais antiga é de 2026-02-28). Ou seja: o mecanismo de bypass da imutabilidade **nunca havia
sido exercido contra dado real**.

Isso é um risco silencioso: o primeiro expurgo real acontece em **2026-09-01**, e se o bypass
não funcionasse, a rotina falharia sozinha, de madrugada, sem ninguém olhando — e o GranaEvo
ficaria fora da política de retenção que a própria política de privacidade promete.

## Como o mecanismo funciona

Duas peças que precisam se encaixar exatamente:

1. **Trava** — trigger `tg_audit_log_imutavel` (`BEFORE UPDATE OR DELETE`) →
   `bloquear_alteracao_audit_log()`. Levanta exceção em tudo, **exceto** `DELETE` quando
   `current_setting('granaevo.audit_retention') = 'on'`.
2. **Chave** — `purge_audit_log_retention()` (`SECURITY DEFINER`) faz
   `SET LOCAL granaevo.audit_retention = 'on'` e então deleta `created_at < now() - 6 months`.

`SET LOCAL` é escopo de transação: a permissão morre junto com o expurgo. Não há janela em que
o log fique mutável para outra sessão.

> Nota: o trigger é `BEFORE UPDATE OR DELETE` — **`INSERT` não é interceptado**. É proposital:
> o log é append-only e precisa aceitar escrita nova.

## O que foi testado (produção, sem persistir nada)

Tudo rodou dentro de um bloco que termina em `RAISE EXCEPTION`, o que **força ROLLBACK**. Os
números voltam na mensagem de erro; nenhuma escrita sobrevive.

### 1. O expurgo funciona e é cirúrgico

Inserida 1 linha sintética datada de 7 meses atrás (a única elegível — nenhuma linha real passa
de 6 meses), e então chamado o expurgo:

| medida | valor |
|---|---|
| antes | 19.905 |
| após inserir a sintética | 19.906 |
| **linhas purgadas** | **1** |
| depois | 19.905 |
| sintética sobreviveu? | não (0) |

Apagou **exatamente a elegível** — as 19.905 reais não foram tocadas. Isso prova o bypass e
prova que o `WHERE` protege o resto.

### 2. A trava continua travando

| operação | bloqueada? |
|---|---|
| `DELETE` **sem** a flag | ✅ sim |
| `UPDATE` (nunca permitido, nem com flag) | ✅ sim |

Mensagem observada: `[SEGURANCA] Audit log e imutavel. Operacao bloqueada: DELETE`.

O bypass não vaza: só a função `SECURITY DEFINER`, que seta a flag em escopo de transação,
consegue deletar.

### 3. Nada persistiu

Conferido após os testes: **19.905** linhas, **0** linhas de teste, `min(created_at)` e
`max(created_at)` idênticos aos de antes, 0 operações fora do CHECK.

## Como reproduzir

O teste é o bloco `DO $$ ... RAISE EXCEPTION ... $$` descrito acima: insere sintética antiga →
chama `purge_audit_log_retention()` → mede → explode de propósito para rolar tudo de volta.
A exceção final é o mecanismo de segurança, não uma falha.

## O que ainda vale observar em setembro

Em **2026-09-01** o cron faz o primeiro expurgo com volume real (as linhas de 2026-02-28 em
diante começam a vencer). Vale conferir no dia seguinte:

```sql
SELECT count(*), min(created_at) FROM public.financial_audit_log;
-- e o log do Postgres deve conter: [audit_retention] linhas removidas (>6 meses): N
```
