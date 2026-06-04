# Legacy Migrations — Arquivo Histórico

Estas 47 migrations foram **squashadas** em 2026-06-04.

Todos os seus esquemas (`CREATE TABLE`, `CREATE POLICY`, `CREATE INDEX`, funções, triggers, cron jobs)
estão integralmente aplicados no banco de produção e continuam intactos.

A tabela de rastreamento `supabase_migrations.schema_migrations` foi limpa destas entradas
via a migration `20260604300000_squash_history.sql`.

## Quando consultar estes arquivos

- Para entender a **evolução histórica** do schema (auditoria, debugging de regressões)
- Para recriar um banco do zero em um ambiente de desenvolvimento antigo
- Para entender o contexto de uma decisão de design do banco

## Estado atual do schema (referência rápida)

Tabelas principais:
- `user_data` — dados financeiros criptografados (AES-256-GCM, chave derivada por HKDF)
- `stripe_subscriptions` — assinaturas e status de pagamento
- `account_members` — convidados vinculados a contas
- `guest_invitations` — convites enviados
- `terms_acceptance` — aceites de termos (INSERT-only, LGPD)
- `password_reset_codes` — códigos de reset temporários (service_role only)
- `login_lockouts` — controle de lockout progressivo (15min→1h→24h)
- `edge_rate_limits` — rate limiting das Edge Functions no banco
- `profile_backups` — backups de perfis em downgrade (90 dias LGPD)
- `push_subscriptions` — endpoints VAPID para notificações push
- `stripe_events` — idempotência de webhooks Stripe
- `feature_flags` — feature flags operacionais

RLS ativa em todas as tabelas. FORCE ROW LEVEL SECURITY configurado.
