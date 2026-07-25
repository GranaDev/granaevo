-- 20260725000000_radar_convite_reserva.sql
-- GranaEvo — Migration: libera o tipo 'convite_reserva' em radar_notifications.
-- Rollback: ver 20260725000000_radar_convite_reserva.down.sql
--
-- A reserva compartilhada v2 (convite→aceite) empurra uma notificação para os
-- OUTROS membros da conta quando alguém cria uma reserva com convidados. O tipo
-- precisa entrar no CHECK; nada mais muda (limites de tamanho, url, janela).
-- O tipo NÃO entra na lista de delete do radar.js (não é calculado pelo cliente),
-- então convites pendentes sobrevivem ao sync — igual a 'lembrete'/'meta_batida'.

ALTER TABLE public.radar_notifications DROP CONSTRAINT radar_notifications_tipo_check;
ALTER TABLE public.radar_notifications ADD CONSTRAINT radar_notifications_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro',
    'lembrete', 'resumo_semanal', 'meta_batida', 'convite_reserva'
  ]));
