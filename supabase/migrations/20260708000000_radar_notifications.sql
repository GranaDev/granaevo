-- ============================================================================
-- RADAR GRANAEVO — fila de notificações agendadas pelo cliente
-- ----------------------------------------------------------------------------
-- Arquitetura "o cliente agenda, o servidor só dispara": o navegador calcula
-- os eventos financeiros e grava payloads prontos aqui (sob RLS). O cron
-- diário (Vercel → /api/user-data?radar=1 → edge send-radar-push) entrega o
-- que está vencido via Web Push e marca como 'sent'. O servidor nunca
-- interpreta os dados financeiros do usuário.
--
-- Dedupe: UNIQUE (user_id, dedupe_key). Linhas 'sent' permanecem na tabela
-- (janela de purge de 40 dias) — o INSERT ... ON CONFLICT DO NOTHING do
-- cliente garante que o mesmo evento nunca é notificado duas vezes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.radar_notifications (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dedupe_key  text        NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 120),
  tipo        text        NOT NULL CHECK (tipo IN ('conta_vence','fatura_fecha','assinatura_renova','orcamento_estouro')),
  title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body        text        NOT NULL CHECK (char_length(body)  BETWEEN 1 AND 200),
  url         text        NOT NULL DEFAULT '/dashboard' CHECK (url ~ '^/[a-zA-Z0-9/_#?=&-]{0,199}$'),
  fire_at     timestamptz NOT NULL,
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,

  CONSTRAINT radar_notifications_user_dedupe UNIQUE (user_id, dedupe_key),
  -- fire_at plausível: nada agendado para mais de 60 dias no futuro
  CONSTRAINT radar_fire_at_janela CHECK (fire_at < created_at + interval '60 days')
);

-- Índice do sender: varre só o que está vencido e pendente
CREATE INDEX IF NOT EXISTS radar_notifications_due_idx
  ON public.radar_notifications (fire_at)
  WHERE status = 'pending';

-- ── RLS: usuário só enxerga/gerencia as próprias linhas ─────────────────────
ALTER TABLE public.radar_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY "radar_select_own" ON public.radar_notifications
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT: só para si mesmo e só como 'pending' (nunca nasce 'sent')
CREATE POLICY "radar_insert_own" ON public.radar_notifications
  FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'pending');

-- DELETE: só as próprias e só pendentes — 'sent' fica para o dedupe
CREATE POLICY "radar_delete_own_pending" ON public.radar_notifications
  FOR DELETE USING (auth.uid() = user_id AND status = 'pending');

-- Sem policy de UPDATE para authenticated: quem marca 'sent' é a edge function
-- com service_role (bypassa RLS). Cliente não altera linhas — só cria/remove.

REVOKE ALL ON public.radar_notifications FROM anon;
REVOKE ALL ON public.radar_notifications FROM public;
GRANT SELECT, INSERT, DELETE ON public.radar_notifications TO authenticated;

-- ── Teto por usuário (anti-abuso): máx. 200 linhas ──────────────────────────
-- SECURITY INVOKER: o count roda sob a RLS do próprio usuário (só vê as suas).
CREATE OR REPLACE FUNCTION public.radar_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT count(*) FROM public.radar_notifications WHERE user_id = NEW.user_id) >= 200 THEN
    RAISE EXCEPTION 'radar_notifications: limite de agendamentos atingido';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radar_cap_trigger ON public.radar_notifications;
CREATE TRIGGER radar_cap_trigger
  BEFORE INSERT ON public.radar_notifications
  FOR EACH ROW EXECUTE FUNCTION public.radar_enforce_cap();

-- ── Higiene: purge diário via pg_cron ────────────────────────────────────────
-- 'sent'/'failed' > 40 dias (cobre a janela de dedupe mensal) e 'pending'
-- órfãs > 30 dias (cliente sumiu — nada mais vai regenerar/limpar).
CREATE OR REPLACE FUNCTION public.purge_radar_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.radar_notifications
  WHERE (status IN ('sent','failed') AND created_at < now() - interval '40 days')
     OR (status = 'pending'          AND created_at < now() - interval '30 days');
END;
$$;

REVOKE ALL ON FUNCTION public.purge_radar_notifications() FROM anon;
REVOKE ALL ON FUNCTION public.purge_radar_notifications() FROM authenticated;
REVOKE ALL ON FUNCTION public.purge_radar_notifications() FROM public;

SELECT cron.schedule(
  'purge-radar-notifications',
  '15 3 * * *',
  'SELECT public.purge_radar_notifications();'
);
