-- 20260702000000_chat_parse_rate_backstop.sql
-- GranaEvo — Migration: backstop de rate limit do Assistente (chat-parse) no banco
-- Rollback: ver 20260702000000_chat_parse_rate_backstop.down.sql
--
-- CONTEXTO (god-mode/god-eyes 2026-07-02, achado M1):
--   O rate limit primário do assistente vive no proxy Vercel (/api/user-data:
--   janela por ip/uid + teto diário 120/usuário). A Edge Function chat-parse
--   confiava 100% nesse proxy. Se o PROXY_SECRET vazasse, um atacante com um JWT
--   válido poderia chamar a Edge direto e queimar tokens da Anthropic sem teto.
--
--   Este backstop cria um contador por (usuário, dia) que a própria Edge consulta
--   via RPC atômica ANTES de chamar a IA. Cap folgado (200/dia > 120 do proxy) →
--   nunca dispara em uso normal; só quando o proxy é contornado.
--
-- SEGURANÇA:
--   • Tabela com RLS ligado e SEM políticas → anon/authenticated não leem/escrevem.
--   • Só a função SECURITY DEFINER (dona = postgres) toca a tabela.
--   • EXECUTE da função revogado de public/anon/authenticated; concedido só a
--     service_role (o papel que a Edge usa). Evita o lint 0029 (authenticated
--     executando SECURITY DEFINER).
--   • search_path travado ('') → nomes totalmente qualificados, sem hijack.
--   • FK ON DELETE CASCADE p/ auth.users → LGPD: contadores somem com a conta.
--   • Sem PII: só user_id (uuid), dia (date) e contador (int).

-- ── 1. Tabela de contagem (uma linha por usuário/dia) ────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_parse_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.chat_parse_usage ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy criada de propósito: com RLS ligado e sem política, nenhum
-- papel (anon/authenticated) enxerga ou grava. A escrita passa só pela função
-- SECURITY DEFINER abaixo. Revoga também grants herdados via PUBLIC.
REVOKE ALL ON public.chat_parse_usage FROM PUBLIC, anon, authenticated;

-- ── 2. RPC atômica: incrementa e devolve se está DENTRO do teto ──────────────
-- Retorna TRUE  = requisição permitida (contador ≤ cap)
--         FALSE = teto do dia estourado
CREATE OR REPLACE FUNCTION public.chat_parse_bump(p_user_id UUID, p_cap INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  -- UPSERT atômico: primeira mensagem do dia insere 1; demais incrementam.
  INSERT INTO public.chat_parse_usage AS u (user_id, day, count)
  VALUES (p_user_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (user_id, day)
  DO UPDATE SET count = u.count + 1
  RETURNING u.count INTO v_count;

  -- Higiene barata: remove linhas antigas SÓ deste usuário (mantém a tabela enxuta
  -- sem varredura global). Guarda 2 dias por segurança de fuso.
  DELETE FROM public.chat_parse_usage
  WHERE user_id = p_user_id
    AND day < (now() AT TIME ZONE 'utc')::date - 2;

  RETURN v_count <= p_cap;
END;
$function$;

-- Só a Edge (service_role) pode executar. Nunca o cliente autenticado.
REVOKE ALL ON FUNCTION public.chat_parse_bump(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_parse_bump(UUID, INTEGER) TO service_role;
