-- =============================================================================
-- GranaEvo — Migration: Final Hardening (GOD MODE Final Round)
-- =============================================================================
-- Correções aplicadas:
--   [FINAL-H01] terms_acceptance: INSERT RLS policy ausente — terms nunca
--               gravados para usuários de primeiroacesso (compliance LGPD/GDPR)
--   [FINAL-M03] Cron jobs de limpeza ativados para login_lockouts e
--               edge_rate_limits (tabelas cresciam indefinidamente)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. [FINAL-H01] INSERT policy para terms_acceptance
--
-- Contexto: primeiroacesso.js chama supabase.from('terms_acceptance').insert()
-- via anon key + JWT do usuário. Sem policy de INSERT, o banco rejeita
-- silenciosamente (RLS força deny por default). O aceite LGPD/GDPR não era
-- gravado para novos usuários que passam pelo fluxo de primeiroacesso.
--
-- A policy WITH CHECK (user_id = auth.uid()) garante que:
--   (a) Apenas usuários autenticados inserem
--   (b) Cada usuário só insere registros com seu próprio user_id
--   (c) Não é possível inserir aceitações falsas para outros usuários
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "terms_owner_insert" ON public.terms_acceptance
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. [FINAL-M03] Cron jobs de limpeza automática
--
-- Contexto: as migrations anteriores criaram os cron jobs comentados.
-- Sem limpeza periódica, as tabelas login_lockouts e edge_rate_limits
-- crescem indefinidamente. Com índices, as queries ainda são rápidas
-- até ~1M linhas, mas o storage e o VACUUM são afetados.
--
-- Requer pg_cron habilitado (ativo por padrão no Supabase).
-- ─────────────────────────────────────────────────────────────────────────────

-- Limpa lockouts expirados há mais de 48h — roda às 3h diariamente
SELECT cron.schedule(
  'granaevo-limpar-lockouts',
  '0 3 * * *',
  $$
    DELETE FROM public.login_lockouts
     WHERE (locked_until IS NULL      AND last_attempt_at < now() - interval '48 hours')
        OR (locked_until IS NOT NULL  AND locked_until     < now() - interval '48 hours');
  $$
);

-- Limpa rate limits expirados há mais de 2h — roda a cada hora
SELECT cron.schedule(
  'granaevo-limpar-rate-limits',
  '0 * * * *',
  $$
    DELETE FROM public.edge_rate_limits
     WHERE window_start < now() - interval '2 hours';
  $$
);

-- Limpa nonces de convite expirados — roda a cada 15 minutos
SELECT cron.schedule(
  'granaevo-limpar-nonces',
  '*/15 * * * *',
  $$
    DELETE FROM public.invite_nonces
     WHERE expires_at < now() - interval '10 minutes';
  $$
);

-- Limpa rate limits de convite expirados — roda a cada hora
SELECT cron.schedule(
  'granaevo-limpar-invite-rate-limit',
  '30 * * * *',
  $$
    DELETE FROM public.invite_rate_limit
     WHERE expires_at < now() - interval '30 minutes';
  $$
);
