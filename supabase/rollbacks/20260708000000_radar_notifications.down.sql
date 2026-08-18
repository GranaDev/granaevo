-- Rollback do Radar GranaEvo
SELECT cron.unschedule('purge-radar-notifications');
DROP FUNCTION IF EXISTS public.purge_radar_notifications();
DROP TRIGGER IF EXISTS radar_cap_trigger ON public.radar_notifications;
DROP FUNCTION IF EXISTS public.radar_enforce_cap();
DROP TABLE IF EXISTS public.radar_notifications;
