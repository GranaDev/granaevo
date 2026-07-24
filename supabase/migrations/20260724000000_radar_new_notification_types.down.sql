-- 20260724000000_radar_new_notification_types.down.sql
-- GranaEvo — Rollback: 20260724000000_radar_new_notification_types.sql
-- ATENCAO: so em emergencia. Remove os 2 tipos novos da lista permitida.
-- Apaga PRIMEIRO as linhas desses tipos, senao o CHECK antigo falha ao ser
-- recriado (linha existente violaria a nova restricao). Sao notificacoes
-- efemeras (fila de push), nao dado do usuario.

DELETE FROM public.radar_notifications WHERE tipo IN ('resumo_semanal', 'meta_batida');

ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro', 'lembrete'
  ]));
