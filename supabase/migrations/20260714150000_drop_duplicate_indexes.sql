-- 20260714150000_drop_duplicate_indexes.sql
-- GranaEvo — Migration: higiene de índices (Passo 19). Remove índices DUPLICADOS.
-- Rollback: ver 20260714150000_drop_duplicate_indexes.down.sql
--
-- CRITÉRIO (auditoria 2026-07-14): dropa APENAS índices que duplicam outro índice
-- na MESMA tabela sobre as MESMAS colunas (detectado via pg_index por indkey). Cada
-- um dos 12 abaixo é redundante porque uma UNIQUE (ou um irmão idêntico) já cobre a
-- mesma coluna → o planner usa o remanescente sem regressão. Reduz amplificação de
-- escrita (ex.: user_data mantinha 3 índices idênticos de user_id).
--
-- NÃO removemos os índices meramente "idx_scan=0": num app pré-escala isso significa
-- "ainda sem tráfego", não "inútil" — eles sustentam RLS/lookup/FK e seriam necessários
-- em escala. Manter é a decisão correta.
--
-- SEGURANÇA: nenhum toca constraint/PK/unique. Todos são não-únicos e têm cobertura
-- redundante garantida pela UNIQUE correspondente.

DROP INDEX IF EXISTS public.idx_user_data_user_id;              -- dup de user_data_user_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_user_data_user_id_partial;      -- dup de user_data_user_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_user_profile_management_user_id; -- dup de user_profile_management_user_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_terms_acceptance_user_version;  -- dup de terms_acceptance_user_version_unique (UNIQUE)
DROP INDEX IF EXISTS public.idx_invite_nonces_nonce;            -- dup de invite_nonces_nonce_unique (UNIQUE)
DROP INDEX IF EXISTS public.idx_rate_limit_identifier;          -- dup de invite_rate_limit_unique (UNIQUE)
DROP INDEX IF EXISTS public.idx_login_lockouts_identifier;      -- dup de login_lockouts_identifier_type_uq (UNIQUE)
DROP INDEX IF EXISTS public.stripe_subscriptions_customer_id_idx; -- dup de stripe_subscriptions_stripe_customer_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_snapshots_user_date;            -- dup de uq_snapshot_user_date (UNIQUE)
DROP INDEX IF EXISTS public.idx_subscriptions_payment;          -- dup de subscriptions_payment_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_financial_audit_log_actor_id;   -- dup de idx_audit_log_actor_id (mesma coluna actor_id)
DROP INDEX IF EXISTS public.idx_guest_invitations_email_status; -- dup de idx_guest_inv_email_used_expires (mesmas 3 colunas)
