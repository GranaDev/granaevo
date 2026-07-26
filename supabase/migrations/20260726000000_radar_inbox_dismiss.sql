-- 20260726000000_radar_inbox_dismiss.sql
-- GranaEvo — Caixa de entrada de notificações no app.
-- Rollback: ver 20260726000000_radar_inbox_dismiss.down.sql
--
-- PROBLEMA: tudo o que o Radar (e o convite de reserva compartilhada) empurrava
-- existia SÓ como push do sistema operacional. Quem não viu a bolha na hora não
-- via mais nada: o sino do app lista apenas contas a vencer, calculadas no
-- cliente. Nada do que o servidor manda ficava guardado para ler ou apagar.
--
-- SOLUÇÃO: `radar_notifications` já guarda cada aviso (title/body/url, sem R$ —
-- regra de privacidade do Radar). Falta só o usuário poder DISPENSAR um aviso
-- sem apagar a linha: apagar quebraria o dedupe (`status='sent'` é o que impede
-- o mesmo evento de notificar de novo) e o aviso voltaria no próximo sync.
--
-- POR QUE NÃO BASTOU UMA POLÍTICA DE UPDATE: com UPDATE liberado, o dono poderia
-- reescrever status/fire_at/title da própria linha e se re-notificar em loop, ou
-- mandar a si mesmo um payload arbitrário. A política autoriza a LINHA; o trigger
-- congela as COLUNAS — só `dismissed_at` muda. O disparador (send-radar-push,
-- service_role, sem auth.uid()) continua livre para marcar sent/failed.

ALTER TABLE public.radar_notifications
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- Índice do caminho quente: "meus avisos ainda não dispensados, mais novos primeiro".
CREATE INDEX IF NOT EXISTS radar_notifications_inbox_idx
  ON public.radar_notifications (user_id, created_at DESC)
  WHERE dismissed_at IS NULL;

-- Congela todas as colunas exceto dismissed_at quando quem escreve é um USUÁRIO
-- (auth.uid() não nulo). O service_role passa direto — é ele que marca sent/failed.
CREATE OR REPLACE FUNCTION public.radar_notifications_freeze_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;  -- service_role (send-radar-push): pode marcar status/sent_at
  END IF;
  NEW.id         := OLD.id;
  NEW.user_id    := OLD.user_id;
  NEW.dedupe_key := OLD.dedupe_key;
  NEW.tipo       := OLD.tipo;
  NEW.title      := OLD.title;
  NEW.body       := OLD.body;
  NEW.url        := OLD.url;
  NEW.fire_at    := OLD.fire_at;
  NEW.status     := OLD.status;
  NEW.sent_at    := OLD.sent_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radar_notifications_freeze_columns_trg ON public.radar_notifications;
CREATE TRIGGER radar_notifications_freeze_columns_trg
  BEFORE UPDATE ON public.radar_notifications
  FOR EACH ROW EXECUTE FUNCTION public.radar_notifications_freeze_columns();

-- UPDATE só na própria linha (USING) e sem poder transferir a linha (WITH CHECK).
DROP POLICY IF EXISTS radar_update_own_dismiss ON public.radar_notifications;
CREATE POLICY radar_update_own_dismiss ON public.radar_notifications
  FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
