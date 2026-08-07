-- 20260807000000_purge_preserva_dispensadas.sql
-- GranaEvo — A purga não pode apagar a DISPENSA antes do evento morrer.
-- Rollback: ver 20260807000000_purge_preserva_dispensadas.down.sql
--
-- CONTEXTO
--   O commit 59468cc consertou o bug "excluo as notificações e elas voltam no
--   próximo login": o delete do reagendamento (radar.js) passou a preservar
--   linhas com `dismissed_at`, porque é justamente a linha dispensada
--   sobrevivente que faz o `ignoreDuplicates` do upsert pular o evento.
--
-- O QUE FICOU ABERTO
--   A dispensa só continua valendo enquanto a LINHA existir. Esta purga apagava
--   qualquer 'pending' com mais de 30 dias — inclusive as dispensadas. Como o
--   Radar enxerga 35 dias à frente, havia uma janela real:
--
--     dia 0   usuário dispensa o aviso de uma conta que vence em 33+ dias
--             (o aviso "vence em 3 dias" é agendado para o dia 30)
--     dia 30  a purga apaga a linha — e a dispensa junto
--     dia 30  o próximo sync do Radar recria o evento: o aviso VOLTA
--
--   Estreito (só pega vencimento a 33–38 dias), mas é exatamente o mesmo bug que
--   o usuário relatou, entrando por outra porta.
--
-- A CORREÇÃO
--   Linha dispensada passa a ser retida 40 dias, como 'sent'/'failed'. O número
--   não é arbitrário: a janela do Radar é de 35 dias (`limite = hoje + 35` em
--   _computarEventos), e o agendador descarta evento cujo disparo já passou
--   (`if (fire < agora - 1h) return`). Com 40 > 35, quando a linha finalmente é
--   apagada o evento dela já morreu e não há o que recriar. Fecha a janela em
--   vez de encolhê-la.
--
--   Efeito colateral: nenhum. A purga passa a apagar ESTRITAMENTE MENOS linhas.
--
-- NOTA
--   `search_path` mantido como está em produção ('public, extensions, pg_temp',
--   endurecido depois da migration original 20260708000000). Reescrever esta
--   função com o `SET search_path = public` do arquivo original desfaria esse
--   hardening sem ninguém perceber.

CREATE OR REPLACE FUNCTION public.purge_radar_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.radar_notifications
  WHERE (status IN ('sent','failed')
           AND created_at < now() - interval '40 days')
     -- Pendente NUNCA dispensada: retenção curta de sempre (inalterada).
     OR  (status = 'pending' AND dismissed_at IS NULL
           AND created_at < now() - interval '30 days')
     -- Pendente DISPENSADA: só depois da janela de 35 dias do Radar, senão
     -- apagar a linha ressuscita o aviso que a pessoa mandou embora.
     OR  (status = 'pending' AND dismissed_at IS NOT NULL
           AND created_at < now() - interval '40 days');
END;
$$;
