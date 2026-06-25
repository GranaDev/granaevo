# Baseline schema — Disaster Recovery & Auditabilidade

> **Por que este diretório existe (achado M1 da auditoria):**
> O squash em [`migrations/20260604300000_squash_history.sql`](../migrations/20260604300000_squash_history.sql)
> removeu o tracking das 47 migrations antigas. O DDL das tabelas centrais
> (`user_data`, `profiles`, `account_members`) **não vive mais no repo** — vive só
> no banco em produção. Consequências:
>
> 1. **Disaster recovery quebrado:** um `git clone` não reconstrói o RLS dessas tabelas.
>    Se o projeto Supabase for perdido/corrompido, o esquema não é reproduzível.
> 2. **Auditabilidade:** nem o `/god-eyes` Fase 3 nem um revisor externo conseguem
>    *provar* que `user_data` tem `FORCE RLS` + `WITH CHECK` no UPDATE — e o dado
>    financeiro real mora ali.
>
> Versionar o dump fecha os dois gaps.

## Estado atual

[`public_baseline.sql`](public_baseline.sql) **já foi gerado** (2026-06-25) via Supabase
Management API (introspecção schema-only) — 23 tabelas, 55 políticas, 47 funções, 7 triggers,
120 índices. Auditoria de RLS confirmada nas tabelas centrais: `user_data`, `profiles`,
`account_members` e `stripe_subscriptions` todas com `ENABLE` + `FORCE ROW LEVEL SECURITY`
e `WITH CHECK` em todos os UPDATEs. `stripe_events` é fechada (FORCE RLS + 0 policies →
só `service_role`, correto para tabela interna de idempotência).

> Foi usado o método Management API (não o `supabase db dump` abaixo) porque esta máquina
> não tem Docker nem `pg_dump` nativo, que o CLI exige. O método CLI continua sendo o
> preferido para regeneração quando o Docker estiver disponível.

## Como regenerar o baseline (CLI — método preferido)

Pré-requisito: [Supabase CLI](https://supabase.com/docs/guides/cli) logado e linkado
ao projeto (`supabase link --project-ref fvrhqqeofqedmhadzzqw`).

```bash
# Schema completo do public (tabelas, RLS, policies, funções, triggers, índices).
# --schema-only NÃO traz dados (nenhum dado de usuário sai do banco).
supabase db dump --schema public --schema-only > supabase/schema/public_baseline.sql

# (Opcional) roles/grants e RLS de outros schemas relevantes:
supabase db dump --schema auth --schema-only > supabase/schema/auth_baseline.sql
```

Depois: **revise o arquivo** (confirme `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
e `WITH CHECK` nas policies de UPDATE de `user_data`/`profiles`/`account_members`),
e commite.

## Importante — isto é REFERÊNCIA, não migration

Estes arquivos ficam em `schema/` (não em `migrations/`) **de propósito**: são um
snapshot de DR/auditoria, não devem ser reaplicados automaticamente pelo CLI contra o
banco vivo (replay de DDL existente quebraria). Para reconstruir do zero num projeto
novo, aplique manualmente:

```bash
psql "$DATABASE_URL" -f supabase/schema/public_baseline.sql
```

## Manutenção

Regere após qualquer migration que altere as tabelas centrais. Idealmente vire um
passo no fim de toda task que mexe no banco (a regra "Rodar /god-eyes após qualquer
migration" do CLAUDE.md já é o gatilho natural).
