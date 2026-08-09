-- ============================================================================
-- B-4 · Alerta ativo de segurança, não só log
-- ============================================================================
-- O gap: `fraud_logs` e `login_lockouts` registram, e ninguém lê. Um ataque de
-- força bruta ou uma sequência de fraude ficam esperando alguém abrir o painel.
--
-- O que JÁ existia e foi reaproveitado: a edge `cron-health-alert` manda e-mail
-- por Resend para `SECURITY_ALERT_EMAIL`, é disparada pela Vercel Cron via
-- `/api/user-data?cron-health=1` com `x-proxy-secret`, e lê uma RPC restrita ao
-- service_role. Só faltava a RPC que enxerga evento de SEGURANÇA.
--
-- ⚠️ NENHUMA ROTA NOVA em api/. A Vercel congela o deploy inteiro, em silêncio,
-- na 13ª função — hoje são 10. O alerta de segurança pega carona no mesmo
-- `?cron-health=1` em vez de custar um slot.
--
-- Espelha get_cron_failures_24h: SECURITY DEFINER, search_path travado, EXECUTE
-- revogado de todo mundo e concedido só ao service_role.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_security_events_recent(
  p_minutos integer DEFAULT 60,
  p_limiar  integer DEFAULT 5
)
RETURNS TABLE (fonte text, eventos bigint, alvos bigint, mais_recente timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  -- Bloqueios de login: força bruta em andamento. `identifier` é e-mail ou IP,
  -- então `alvos` distingue "um alvo insistente" de "muitos alvos varridos" —
  -- a segunda forma é a que indica ataque distribuído.
  SELECT 'login_lockouts'::text,
         count(*)::bigint,
         count(DISTINCT l.identifier)::bigint,
         max(l.created_at)
  FROM public.login_lockouts l
  WHERE l.created_at > now() - make_interval(mins => p_minutos)
  HAVING count(*) >= p_limiar

  UNION ALL

  -- Fraude de pagamento: sequência curta é sinal, evento isolado é ruído.
  SELECT 'fraud_logs'::text,
         count(*)::bigint,
         count(DISTINCT f.user_id)::bigint,
         max(f.created_at)
  FROM public.fraud_logs f
  WHERE f.created_at > now() - make_interval(mins => p_minutos)
  HAVING count(*) >= p_limiar;
$$;

COMMENT ON FUNCTION public.get_security_events_recent(integer, integer) IS
  'B-4: janelas de evento de seguranca acima do limiar. So devolve linha quando '
  'ha o que alertar — silencio e a resposta normal. Consumida por cron-health-alert.';

-- SECURITY DEFINER sem REVOKE é escada de privilégio: por padrão o PUBLIC pode
-- executar, e aí qualquer `authenticated` lê a temperatura de segurança do app.
REVOKE ALL ON FUNCTION public.get_security_events_recent(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_security_events_recent(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_security_events_recent(integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_security_events_recent(integer, integer) TO service_role;
