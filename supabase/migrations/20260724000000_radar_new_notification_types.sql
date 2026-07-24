-- 20260724000000_radar_new_notification_types.sql
-- GranaEvo — Migration: libera 2 novos tipos em radar_notifications (RF-03)
-- Rollback: ver 20260724000000_radar_new_notification_types.down.sql
--
-- RF-03 (resumo semanal de domingo + marco de meta batida) precisa INSERIR tipos
-- que o CHECK atual nao permite (so aceita os 5 originais). Adiciona
-- 'resumo_semanal' e 'meta_batida' a lista permitida. Nada mais muda: os limites
-- de tamanho (title/body/dedupe), a janela de 60 dias e o padrao de url continuam.

ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro',
    'lembrete', 'resumo_semanal', 'meta_batida'
  ]));
