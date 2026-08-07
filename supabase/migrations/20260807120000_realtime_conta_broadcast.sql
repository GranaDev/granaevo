-- ============================================================================
-- Passo 37 · Camada 1 — TEMPO REAL: quem pode OUVIR o aviso de uma conta
--
-- O dono pediu: "um usuário altera, outro já vê em tempo real". O desenho é uma
-- CAMPAINHA, não uma entrega: o servidor anuncia "a conta X mudou, nos perfis
-- Y", e quem ouve busca os dados pelo caminho normal (get-user-data, que decifra
-- server-side). Nenhum centavo trafega pelo canal.
--
-- ── POR QUE BROADCAST, E NÃO REPLICAÇÃO DA TABELA ──────────────────────────
-- `postgres_changes` exigiria publicar mudanças de `user_data` — a tabela que
-- guarda o dinheiro — no WAL, para o Realtime ler. O próprio CLAUDE.md avisa:
-- "Realtime pode bypassar RLS se não configurado". Um engano ali vaza linha.
--
-- Com broadcast:
--   · O CLIENTE SÓ ESCUTA. Não existe política de INSERT aqui, então nenhum
--     usuário autenticado pode emitir aviso. Só o servidor (secret key, que
--     ignora RLS) anuncia. Ninguém pode forjar "a conta mudou".
--   · A publicação de Realtime continua VAZIA. Não há caminho, nem futuro nem
--     acidental, pelo qual `data_json` chegue a um websocket.
--   · O aviso é nosso: leva os ids dos perfis tocados, então quem ouve só busca
--     quando é do interesse dele.
--
-- ⚠️ CANAL PÚBLICO NÃO PASSA POR AQUI. A autorização do Realtime só se aplica a
-- canal PRIVADO (`config: { private: true }` no cliente). Um canal público com o
-- mesmo nome de tópico seria audível por qualquer um que soubesse o id. O
-- cliente assina privado — e o teste `realtime-conta.test.js` trava isso.
-- ============================================================================

-- ── O id da conta a partir do tópico ────────────────────────────────────────
-- Tópico é `conta:<uuid>`. Devolve NULL para qualquer outra coisa.
--
-- O casamento pelo formato COMPLETO de uuid não é enfeite: `substring(...)::uuid`
-- em texto inválido levanta exceção, e exceção dentro de uma política derruba a
-- consulta inteira em vez de negar. Validar antes de converter transforma
-- "tópico esquisito" em NULL, e NULL em negação — que é o que se quer.
CREATE OR REPLACE FUNCTION public.conta_do_topico(topico text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN topico ~ '^conta:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN substring(topico FROM 7)::uuid
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION public.conta_do_topico(text) IS
  'Passo 37: extrai o id da conta de um tópico Realtime "conta:<uuid>". NULL se não casar.';

REVOKE ALL ON FUNCTION public.conta_do_topico(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.conta_do_topico(text) TO authenticated;

-- ── Quem pode OUVIR ─────────────────────────────────────────────────────────
-- Espelha exatamente `user_data_select`, a política que já decide quem enxerga
-- os dados da conta: o dono, e os membros ATIVOS registrados em
-- `account_members`. Reusar a mesma regra é intencional — duas definições de
-- "quem é da conta" divergem com o tempo, e a que diverge vira o furo.
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
      SELECT 1
      FROM public.account_members am
      WHERE am.owner_user_id  = public.conta_do_topico(realtime.topic())
        AND am.member_user_id = (SELECT auth.uid())
        AND am.is_active      = true
    )
  )
);

-- NENHUMA política de INSERT, de propósito. Sem ela, `authenticated` não emite
-- broadcast nenhum: o servidor é a única boca. Se um dia alguém precisar que o
-- cliente anuncie algo (presença, "fulano está digitando"), que seja uma
-- decisão consciente, com política própria — e não um efeito colateral desta.
