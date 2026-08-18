-- Reverte a presença: tira a escrita do cliente e volta a leitura só a broadcast.
DROP POLICY IF EXISTS "conta_presenca_entrar" ON realtime.messages;
DROP POLICY IF EXISTS "conta_broadcast_ouvir" ON realtime.messages;

CREATE POLICY "conta_broadcast_ouvir"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  extension = 'broadcast'
  AND public.conta_do_topico(realtime.topic()) IS NOT NULL
  AND (
    (SELECT auth.uid()) = public.conta_do_topico(realtime.topic())
    OR EXISTS (
      SELECT 1 FROM public.account_members am
      WHERE am.owner_user_id  = public.conta_do_topico(realtime.topic())
        AND am.member_user_id = (SELECT auth.uid())
        AND am.is_active      = true
    )
  )
);
