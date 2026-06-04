# GranaEvo — Auditoria RLS (análise estática de migrations)
Data: 2026-06-04 | God Mode + God Eyes Ultra

## 2.1 — Tabelas sem RLS

Todas as tabelas identificadas nas migrations possuem RLS habilitado.

| Tabela | RLS | FORCE RLS | Fonte |
|--------|-----|-----------|-------|
| user_data | ✅ | ✅ | 20260426200000_rls_all_tables |
| subscriptions | ✅ | ✅ | 20260426200000_rls_all_tables |
| payment_events | ✅ | ✅ | service_role only |
| terms_acceptance | ✅ | ✅ | 20260426200000_rls_all_tables |
| account_members | ✅ | ✅ | 20260426200000_rls_all_tables |
| guest_invitations | ✅ | ✅ | 20260426200000_rls_all_tables |
| password_reset_codes | ✅ | ✅ | service_role only |
| invite_rate_limit | ✅ | ✅ | service_role only |
| invite_nonces | ✅ | ✅ | service_role only |
| fraud_logs | ✅ | ✅ | service_role only |
| stripe_subscriptions | ✅ | ✅ | 20260504000000 + 20260505000000 |
| push_subscriptions | ✅ | ✅ | 20260601000000 |
| feature_flags | ✅ | ✅ | 20260531000001 |
| edge_rate_limits | REVOKE ALL | — | service_role somente |

**RESULTADO: Nenhuma tabela sem RLS identificada.**

## 2.2 — Tabelas com RLS mas sem policies

Tabelas internas (edge_rate_limits, payment_events, etc.) usam REVOKE ALL + service_role,
que é equivalente a "nenhuma policy para roles não-service_role" — comportamento correto.

**RESULTADO: Nenhum problema identificado.**

## 2.3 — Políticas existentes (resumo)

### user_data
- SELECT: `user_id = auth.uid()` ✅
- INSERT/UPDATE: service_role only (sem policy = RLS deny) ✅

### terms_acceptance
- SELECT: `user_id = auth.uid()` ✅
- INSERT: `WITH CHECK (user_id = auth.uid())` ✅ (adicionado em final_hardening)

### account_members
- SELECT: `owner_user_id = auth.uid() OR member_user_id = auth.uid()` ✅

### stripe_subscriptions
- SELECT own: `user_id = auth.uid()` ✅
- SELECT by email (anon purchase): `lower(user_email) = lower(auth.jwt()->>'email')` ⚠️ LOW-04
- UPDATE auto-link: USING (user_id IS NULL AND email match) WITH CHECK (auth.uid() = user_id) ✅

### push_subscriptions
- SELECT/INSERT/UPDATE/DELETE: `auth.uid() = user_id` — 4 operações cobertas ✅
- WITH CHECK em UPDATE ✅
- REVOKE ALL FROM anon e public ✅

### feature_flags
- SELECT: `target_user_id IS NULL OR target_user_id = auth.uid()` ✅
- Escrita: service_role only ✅

## 2.4 — UPDATE sem WITH CHECK

**RESULTADO: Nenhum UPDATE sem WITH CHECK encontrado.**

Todos os UPDATE policies encontrados nas migrations incluem WITH CHECK:
- push_subscriptions.push_update_own: WITH CHECK (auth.uid() = user_id) ✅
- stripe_subscriptions.stripe_sub_update_claim: WITH CHECK (auth.uid() = user_id) ✅

## 2.5 — Views sem security_invoker

Nenhuma VIEW SQL encontrada nas migrations analisadas.
A função is_feature_enabled usa SECURITY INVOKER (correto).

**RESULTADO: Sem achados.**

## 2.6 — Funções SECURITY DEFINER

| Função | SET search_path | GRANT | Risco |
|--------|----------------|-------|-------|
| get_auth_user_by_email | extensions, public, auth | service_role only ✅ | Baixo |
| check_rate_limit | extensions, public | service_role only ✅ | Baixo |
| cleanup_expired_rate_limits | extensions, public | service_role ✅ | Baixo |
| cleanup_push_subscriptions | public | ❌ NENHUM | **LOW-03** |
| set_updated_at | — (trigger) | implícito via trigger ✅ | Baixo |

**Achado LOW-03:** cleanup_push_subscriptions não tem GRANT para nenhum role.
Função pode nunca ser executada automaticamente (sem cron configurado explicitamente).

## 2.7 — Tabelas no Realtime

Sem evidência de publicação no Realtime nas migrations.
**RESULTADO: Sem achados.**

## 2.8 — Storage (profile-photos)

- Bucket privado ✅
- Magic bytes validados server-side ✅
- EXIF/XMP/GPS stripped antes do upload ✅
- URL assinada 7 dias via service_role ✅
- GIF explicitamente EXCLUÍDO (polyglot attack vector) ✅

**RESULTADO: Configuração adequada.**

## 2.9 — Permissões ao role anon

Todas as tabelas sensíveis têm `REVOKE ALL FROM anon; REVOKE ALL FROM public;`
**RESULTADO: Nenhum acesso indevido identificado.**
