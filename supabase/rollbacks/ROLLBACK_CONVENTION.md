# GranaEvo — Convenção de Rollback de Migrations

## Regra
A partir de **2026-05-31**, toda nova migration SQL deve ter um arquivo de rollback correspondente.

## ⛔ O ROLLBACK NUNCA MORA EM `supabase/migrations/`

```
supabase/migrations/
└── YYYYMMDDHHMMSS_nome_descritivo.sql         ← migration UP (aplicar)

supabase/rollbacks/
└── YYYYMMDDHHMMSS_nome_descritivo.down.sql    ← migration DOWN (reverter)
```

**Por que dois diretórios — e por que isto está em maiúsculas.** O CLI do Supabase
varre `supabase/migrations/` casando o padrão `<timestamp>_nome.sql`. O arquivo
`..._nome.down.sql` **casa esse padrão também** — para o CLI, o "nome" é `nome.down`.
Ou seja: ele trata todo rollback como uma migration a aplicar.

Consequências reais, medidas em 2026-08-17:

- `supabase migration list` mostrava **cada versão duas vezes**;
- `db push --dry-run` listava `..._user_data_sem_escrita_do_cliente.down.sql`
  entre os arquivos a aplicar — ou seja, um push reverteria um revoke de segurança;
- o ledger tem uma linha `20260712120000 | lgpd_redact_legacy_cakto_pii.down`:
  a versão foi registrada com o nome do arquivo DOWN (que ordena antes do `.sql`),
  e o UP correspondente nunca entrou no ledger com o nome dele;
- toda migration NOVA nasce com par UP+DOWN de versão superior à do remoto, então
  os dois seriam aplicados — o DOWN primeiro.

Esta separação foi decidida em **2026-06-01** (commit `2cb9f0d`, "evita conflito com
db push") e **regrediu**: este documento continuou ensinando o layout antigo, e os
60 rollbacks seguintes foram para `migrations/`. Restaurada em 2026-08-17.
Se você for "simplificar" juntando os dois diretórios de novo, é este parágrafo que
você está contrariando.

## Como criar uma nova migration

### 1. Arquivo UP (obrigatório) — em `supabase/migrations/`
```sql
-- YYYYMMDDHHMMSS_minha_feature.sql
-- GranaEvo — Migration: descrição clara do que faz
-- Rollback: ver supabase/rollbacks/YYYYMMDDHHMMSS_minha_feature.down.sql

-- Seu SQL aqui
CREATE TABLE ...;
ALTER TABLE ...;
CREATE INDEX ...;
```

### 2. Arquivo DOWN (obrigatório) — em `supabase/rollbacks/`
```sql
-- YYYYMMDDHHMMSS_minha_feature.down.sql
-- GranaEvo — Rollback: YYYYMMDDHHMMSS_minha_feature.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
-- Lembre-se: rollback de dados deletados é irreversível.

-- Reverte em ordem INVERSA ao UP
DROP INDEX IF EXISTS ...;
ALTER TABLE ... DROP COLUMN IF EXISTS ...;
DROP TABLE IF EXISTS ...;
```

## Regras de rollback

1. **Ordem inversa**: O DOWN deve desfazer o UP na ordem inversa das operações
2. **Idempotente**: Use `IF EXISTS` / `IF NOT EXISTS` para que o DOWN possa ser executado múltiplas vezes sem erro
3. **Dados**: Operações que deletam dados devem ser documentadas com `-- ⚠️ DESTRÓI DADOS`
4. **RLS**: Se criou tabela + RLS no UP, o DOWN deve dropar políticas ANTES de dropar a tabela
5. **Revisão**: Faça code review do DOWN antes de mergear — ele é tão crítico quanto o UP

## Executar rollback de emergência

```bash
# Via Supabase CLI (local ou CI):
supabase db push --file supabase/migrations/YYYYMMDDHHMMSS_nome.down.sql

# Via psql direto (produção — requer acesso ao banco):
psql $DATABASE_URL -f supabase/migrations/YYYYMMDDHHMMSS_nome.down.sql
```

## Migrations históricas (antes de 2026-05-31)

As migrations anteriores NÃO têm arquivo `.down.sql`. Para reversão de emergência
dessas migrations, consulte o script `supabase/migrations/EMERGENCY_ROLLBACK.sql`
que documenta os passos manuais para reverter as últimas 30 dias de mudanças.

## Template completo

Ver `supabase/migrations/TEMPLATE_UP.sql` e `TEMPLATE_DOWN.sql`.
