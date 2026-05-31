# GranaEvo — Convenção de Rollback de Migrations

## Regra
A partir de **2026-05-31**, toda nova migration SQL deve ter um arquivo de rollback correspondente.

## Estrutura de arquivos

```
supabase/migrations/
├── YYYYMMDDHHMMSS_nome_descritivo.sql         ← migration UP (aplicar)
└── YYYYMMDDHHMMSS_nome_descritivo.down.sql    ← migration DOWN (reverter)
```

## Como criar uma nova migration

### 1. Arquivo UP (obrigatório)
```sql
-- YYYYMMDDHHMMSS_minha_feature.sql
-- GranaEvo — Migration: descrição clara do que faz
-- Rollback: ver YYYYMMDDHHMMSS_minha_feature.down.sql

-- Seu SQL aqui
CREATE TABLE ...;
ALTER TABLE ...;
CREATE INDEX ...;
```

### 2. Arquivo DOWN (obrigatório)
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
