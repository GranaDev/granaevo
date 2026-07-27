-- 20260727060000_radar_dismiss_grant.sql
-- GranaEvo — Migration: GRANT que faltou para o "dispensar" da caixa de entrada (A-2)
-- Rollback: ver 20260727060000_radar_dismiss_grant.down.sql
--
-- O BUG
--   A migration 20260726000000_radar_inbox_dismiss criou a policy
--   `radar_update_own_dismiss` e o trigger que congela as colunas, mas NUNCA
--   adicionou o GRANT. Resultado: `has_column_privilege('authenticated',
--   'radar_notifications','dismissed_at','UPDATE')` era false, o PostgREST
--   devolvia 42501 antes mesmo de avaliar a policy, e o cliente engolia o erro:
--
--     const { error } = await supabase.from('radar_notifications')
--         .update({ dismissed_at: ... }).eq('id', id);
--     if (error) return false;          // <- 42501 morre aqui, sem log
--
--   O X do card ficou morto em produção desde o commit 2d8de79, sem sinal nenhum
--   na aplicação. Falha FECHADA (segura), mas quebrada.
--
-- POR QUE POR COLUNA E NÃO POR TABELA
--   `GRANT UPDATE ON radar_notifications` daria acesso de escrita a title, body,
--   url e user_id. Hoje o trigger `radar_notifications_freeze_columns` impede
--   isso, mas grant e trigger são coisas independentes: no dia em que alguém
--   mexer no trigger, o grant por coluna continua sendo o limite real.
--
-- NOTA DE PROCEDÊNCIA
--   Este GRANT já foi aplicado em produção em 2026-07-27 pela Management API,
--   antes de virar migration. Este arquivo existe para fechar o drift — foi um
--   teste de regressão (tests/unit/seguranca-regressao.test.js) que apontou a
--   ausência. É idempotente: reaplicar não muda nada.

GRANT UPDATE (dismissed_at) ON public.radar_notifications TO authenticated;

NOTIFY pgrst, 'reload schema';
