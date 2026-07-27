-- 20260727060000_radar_dismiss_grant.down.sql
-- GranaEvo — Rollback de 20260727060000_radar_dismiss_grant.sql
--
-- ⚠️ Reverter volta a QUEBRAR o botão de dispensar da caixa de entrada do sino,
-- e de forma silenciosa: o cliente engole o 42501 e o X simplesmente não faz nada.

REVOKE UPDATE (dismissed_at) ON public.radar_notifications FROM authenticated;

NOTIFY pgrst, 'reload schema';
