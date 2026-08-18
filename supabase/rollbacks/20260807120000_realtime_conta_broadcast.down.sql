-- Reverte o Passo 37 · Camada 1 (autorização do canal da conta).
-- Sem a política, `realtime.messages` volta a negar tudo para `authenticated`
-- (RLS ligado, zero políticas) — o tempo real simplesmente para de chegar, sem
-- nada mais deixar de funcionar.
DROP POLICY IF EXISTS "conta_broadcast_ouvir" ON realtime.messages;
DROP FUNCTION IF EXISTS public.conta_do_topico(text);
