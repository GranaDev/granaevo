-- Rollback de 20260807000000_purge_preserva_dispensadas.sql
--
-- Volta a purga ao comportamento anterior: 'pending' apagado aos 30 dias,
-- dispensado ou não.
--
-- ⚠️ REABRE O BUG: um aviso dispensado de conta que vence em 33+ dias volta a
-- reaparecer sozinho ~30 dias depois. Só reverta se a retenção maior estiver
-- causando algum problema concreto de volume — e saiba o que está trocando.
--
-- `search_path` endurecido preservado no rollback também: reverter o
-- comportamento da purga não é motivo para reverter um hardening de segurança.

CREATE OR REPLACE FUNCTION public.purge_radar_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.radar_notifications
  WHERE (status IN ('sent','failed') AND created_at < now() - interval '40 days')
     OR (status = 'pending'          AND created_at < now() - interval '30 days');
END;
$$;
