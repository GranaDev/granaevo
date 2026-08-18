-- Rollback de 20260726000000_radar_inbox_dismiss.sql
-- Remove a caixa de entrada de notificações no app. Depois disto o sino volta a
-- mostrar só as contas a vencer calculadas no cliente.

DROP POLICY  IF EXISTS radar_update_own_dismiss ON public.radar_notifications;
DROP TRIGGER IF EXISTS radar_notifications_freeze_columns_trg ON public.radar_notifications;
DROP FUNCTION IF EXISTS public.radar_notifications_freeze_columns();
DROP INDEX   IF EXISTS public.radar_notifications_inbox_idx;
ALTER TABLE  public.radar_notifications DROP COLUMN IF EXISTS dismissed_at;
