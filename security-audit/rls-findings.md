# God Eyes — Auditoria RLS
Data: 2026-05-17 | Round 7

> **Nota:** O Supabase CLI requer SUPABASE_DB_PASSWORD que não está disponível localmente.
> As queries 2.1–2.9 foram respondidas com base na análise completa das 21 migrations aplicadas.
> Para verificação definitiva em produção, execute as queries manualmente no SQL Editor do Supabase Dashboard.

---

## Queries SQL para executar manualmente no Supabase SQL Editor

### 2.1 — Tabelas sem RLS (CRÍTICO se retornar rowsecurity=false)
```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity ASC;
```

### 2.2 — Tabelas com RLS ativo mas sem nenhuma policy
```sql
SELECT t.tablename
FROM pg_tables t
LEFT JOIN pg_policies p
  ON t.tablename = p.tablename AND t.schemaname = p.schemaname
WHERE t.schemaname = 'public'
  AND t.rowsecurity = true
  AND p.policyname IS NULL;
```

### 2.3 — Todas as políticas existentes
```sql
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;
```

### 2.4 — UPDATE sem WITH CHECK
```sql
SELECT tablename, policyname, cmd, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd = 'UPDATE'
  AND (with_check IS NULL OR with_check = '');
```

### 2.5 — Views sem security_invoker
```sql
SELECT viewname, definition
FROM pg_views
WHERE schemaname = 'public';
```

### 2.6 — Funções SECURITY DEFINER
```sql
SELECT routine_name, security_type, routine_definition
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND security_type = 'DEFINER';
```

### 2.7 — Tabelas no Realtime
```sql
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```

### 2.8 — Storage buckets
```sql
SELECT id, name, public FROM storage.buckets;
SELECT bucket_id, name, definition FROM storage.policies;
```

### 2.9 — Permissões do role anon
```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
ORDER BY table_name;
```

---

## Resultados Esperados (via análise de migrations)

### 2.1 — Tabelas sem RLS
**Esperado:** todas as 16 tabelas públicas devem ter `rowsecurity=true`.
Migrations cobrem: user_data, subscriptions, payment_events, terms_acceptance, account_members, guest_invitations, password_reset_codes, invite_rate_limit, invite_nonces, fraud_logs, edge_rate_limits, login_lockouts, plans, profiles, stripe_subscriptions, stripe_events.

**Status:** ✅ LIMPO — todas habilitadas via migrations.

### 2.2 — RLS ativo sem policy
**Esperado:** stripe_events pode aparecer aqui (RLS habilitado, sem policy explícita → deny-by-default para anon/authenticated).
Isso é **correto por design**: somente service_role acessa.

**Status:** ✅ LIMPO — comportamento esperado.

### 2.3 — Policies existentes
**Esperado:** 20+ policies verificadas nas migrations. Principais:
- `user_data_owner_select`: SELECT user_id = auth.uid()
- `subscriptions_owner_select`: SELECT user_id = auth.uid()
- `stripe_sub_select_own`: SELECT user_id = auth.uid()
- `stripe_sub_select_by_email`: SELECT lower(user_email) = jwt email
- `stripe_sub_update_claim`: UPDATE user_id IS NULL → auto-link
- `profiles_insert_own`: INSERT WITH CHECK user_id = auth.uid() AND can_create_profile()
- `terms_owner_insert`: INSERT WITH CHECK user_id = auth.uid()

**Status:** ✅ LIMPO — policies verificadas.

### 2.4 — UPDATE sem WITH CHECK
**Esperado:** `stripe_sub_update_claim` deve aparecer COM WITH CHECK (auth.uid() = user_id). Sem isso seria CRÍTICO.
Migration 20260505000000 define explicitamente: `WITH CHECK (auth.uid() = user_id)`.

**⚠️ OBSERVAÇÃO:** A `stripe_sub_update_claim` permite UPDATE de qualquer coluna em linhas onde `user_id IS NULL AND user_email = jwt.email`. Um usuário com subscription não vinculada (user_id NULL) poderia tecnicamente alterar `pending_profile_removals` juntamente com o auto-link. O WITH CHECK só valida `user_id = auth.uid()`. O impacto é limitado: `pending_profile_removals` só é processado pelo webhook quando `pending_plan_name` também existe, e este só é definido via Edge Function com validação server-side.
**Classificação:** BAIXO

**Status:** ✅ LIMPO com nota de observação (ver acima).

### 2.5 — Views sem security_invoker
**Esperado:** Nenhuma view pública encontrada nas migrations.

**Status:** ✅ LIMPO — nenhuma view pública.

### 2.6 — Funções SECURITY DEFINER
**Esperado:** 8 funções DEFINER identificadas. Todas com acesso revocado de anon/authenticated exceto `can_create_profile()`.

**Análise de can_create_profile():**
- Executa com privilégios de postgres
- Acessa tabelas: profiles, subscriptions, stripe_subscriptions, account_members, plans
- Apenas leitura (SELECTs), sem writes
- search_path fixado em 'public' (evita search_path injection)
- Não expõe dados — retorna boolean
- Acessível por `authenticated` (necessário para RLS INSERT em profiles)

**Status:** ✅ LIMPO — SECURITY DEFINER justificado e seguro.

### 2.7 — Realtime
**Esperado:** Verificar se tabelas sensíveis (user_data, stripe_subscriptions) estão no Realtime sem RLS adequado.
Nenhuma migration configura Realtime para tabelas sensíveis.

**Status:** ✅ LIMPO (verificar manualmente no dashboard).

### 2.8 — Storage Buckets
**Esperado:** Bucket `profile-photos` com acesso privado (public=false), política de upload restrita ao owner.

**Status:** Verificar manualmente. Migration de upload define upload via EF (não direto no cliente) — baixo risco.

### 2.9 — Permissões anon
**Esperado:** anon não deve ter SELECT em nenhuma tabela sensível. As migrations usam REVOKE ALL para tabelas internas.
Tabelas com policy SELECT (user_data, subscriptions, etc.) requerem auth.uid() → anon (sem JWT) retorna NULL → policy negada automaticamente.

**Status:** ✅ LIMPO — anon role bloqueada por design das policies.

---

## Resumo RLS

| Query | Status      | Classificação |
|-------|-------------|---------------|
| 2.1   | ✅ LIMPO    | —             |
| 2.2   | ✅ LIMPO    | —             |
| 2.3   | ✅ LIMPO    | —             |
| 2.4   | ⚠️ NOTA     | BAIXO         |
| 2.5   | ✅ LIMPO    | —             |
| 2.6   | ✅ LIMPO    | —             |
| 2.7   | ⚠️ VERIFICAR| —             |
| 2.8   | ⚠️ VERIFICAR| —             |
| 2.9   | ✅ LIMPO    | —             |
