-- ============================================================================
-- Passo 37 · Camada 3 — PRESENÇA ("Ke está online")
--
-- Eu tinha recusado isto, e o motivo era real: presença exige que o CLIENTE
-- escreva no canal, e eu não queria abrir escrita em `realtime.messages`. O dono
-- decidiu que quer o recurso. Ele entra — com a garantia preservada.
--
-- ── O QUE TORNA ISTO SEGURO ────────────────────────────────────────────────
-- Presença e broadcast são valores DIFERENTES da coluna `extension` na mesma
-- tabela. Dá para conceder escrita numa sem conceder na outra:
--
--   INSERT + extension = 'presence'   → PERMITIDO (dizer "estou aqui")
--   INSERT + extension = 'broadcast'  → continua NEGADO
--
-- Ou seja: um cliente autenticado passa a poder anunciar a própria presença, e
-- continua SEM conseguir forjar "a conta mudou". A campainha segue tendo o
-- servidor como única boca — que era a propriedade que eu não queria perder.
--
-- ── E O QUE O CLIENTE PODE DIZER ───────────────────────────────────────────
-- O conteúdo da presença é escrito pelo cliente, então não dá para confiar
-- nele. Por isso o app manda APENAS o id do perfil, e quem recebe resolve o
-- nome localmente (ver tempo-real.js). Um membro adulterado só consegue
-- afirmar ser outro perfil DA PRÓPRIA CONTA — que ele já enxerga de qualquer
-- forma. Nome, e-mail e qualquer texto livre ficam fora do fio.
-- ============================================================================

-- ── Ler: broadcast E presença ───────────────────────────────────────────────
-- A política anterior exigia `extension = 'broadcast'`; sem incluir 'presence',
-- ninguém enxergaria quem está online (nem a si mesmo).
DROP POLICY IF EXISTS "conta_broadcast_ouvir" ON realtime.messages;

CREATE POLICY "conta_broadcast_ouvir"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  extension IN ('broadcast', 'presence')
  AND public.conta_do_topico(realtime.topic()) IS NOT NULL
  AND (
    (SELECT auth.uid()) = public.conta_do_topico(realtime.topic())
    OR EXISTS (
      SELECT 1
      FROM public.account_members am
      WHERE am.owner_user_id  = public.conta_do_topico(realtime.topic())
        AND am.member_user_id = (SELECT auth.uid())
        AND am.is_active      = true
    )
  )
);

-- ── Escrever: SOMENTE presença ──────────────────────────────────────────────
-- `extension = 'presence'` no WITH CHECK é a linha que separa "posso dizer que
-- estou aqui" de "posso dizer que a conta mudou". Sem ela, esta política daria
-- ao cliente a boca da campainha.
DROP POLICY IF EXISTS "conta_presenca_entrar" ON realtime.messages;

CREATE POLICY "conta_presenca_entrar"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  extension = 'presence'
  AND public.conta_do_topico(realtime.topic()) IS NOT NULL
  AND (
    (SELECT auth.uid()) = public.conta_do_topico(realtime.topic())
    OR EXISTS (
      SELECT 1
      FROM public.account_members am
      WHERE am.owner_user_id  = public.conta_do_topico(realtime.topic())
        AND am.member_user_id = (SELECT auth.uid())
        AND am.is_active      = true
    )
  )
);
