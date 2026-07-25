-- Rollback de 20260725000000_radar_convite_reserva.sql
-- Volta o CHECK de tipo sem 'convite_reserva'. ATENÇÃO: se existirem linhas com
-- tipo='convite_reserva', apague-as antes (senão o ADD CONSTRAINT falha).
-- DELETE FROM public.radar_notifications WHERE tipo = 'convite_reserva';

ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro',
    'lembrete', 'resumo_semanal', 'meta_batida'
  ]));
