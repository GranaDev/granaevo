-- 20260821000000_purgas_falham_alto_e_fotos_orfas.sql
--
-- Auditoria God Mode + God Eyes de 2026-08-21.
-- Rollback em supabase/rollbacks/20260821000000_*.down.sql
--
-- ⚠️ ATRIBUTOS PRESERVADOS DE PROPÓSITO (conferidos em pg_proc antes de escrever):
--    LANGUAGE plpgsql · SECURITY DEFINER · owner postgres · RETURNS integer
--    SET search_path = public, extensions, pg_temp   ← NÃO é "public, auth, pg_temp".
--    CREATE OR REPLACE mantém owner e ACL (EXECUTE para service_role) porque a
--    assinatura é idêntica. Trocar o search_path de uma função SECURITY DEFINER é
--    mudança de superfície de segurança — não pode acontecer por descuido de cópia.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ACHADO 1 (ALTO) — as duas purgas de conta são FAIL-SILENT
--
-- Ambas envolvem cada linha num BEGIN…EXCEPTION WHEN OTHERS THEN RAISE WARNING.
-- `RAISE WARNING` NÃO aborta: se 100% das exclusões falharem, a função retorna 0,
-- o pg_cron grava `succeeded` e o monitor — que filtra status='failed' — nunca vê
-- nada. É o modo de falha histórico do projeto, agravado: silêncio por construção.
--
-- A resiliência por linha é desejável (uma conta problemática não pode travar o
-- ciclo inteiro). O que falta é PROPAGAR no fim. A correção conta os erros e
-- levanta exceção ao final se houve algum — as exclusões bem-sucedidas já foram
-- commitadas dentro do loop, então nada de útil se perde.
--
-- ACHADO 2 (CRÍTICO, conformidade) — nenhum caminho de exclusão alcança o Storage
--
-- Medido em produção em 2026-08-21: 35 de 44 objetos do bucket `profile-photos`
-- estão em 14 pastas de `user_id` inexistente — 14 de 16 pastas, 6,23 MB, o mais
-- antigo de 2026-01-09.
--
-- `storage.objects` não tem FK para `auth.users`: o vínculo é o NOME do arquivo
-- (`${user_id}/${ts}.ext`, ver upload-profile-photo/index.ts:351). São QUATRO os
-- caminhos que apagam usuário e NENHUM tocava o bucket:
--   1. edge `delete-account`                 → corrigida em código (falta deploy)
--   2. cron purge_unpaid_accounts              ┐ SQL puro: NÃO conseguem chamar a
--   3. cron purge_expired_cancelled_accounts   ├ Storage API. Para estes três a
--   4. cron cleanup_abandoned_accounts         ┘ varredura é o ÚNICO caminho.
--
-- A função abaixo apenas LISTA. A remoção física roda pela Storage API
-- (scripts/purgar-fotos-orfas.mjs): apagar a linha de `storage.objects` deixaria o
-- arquivo no S3 — lixo pago e invisível, sem nem a linha para reencontrá-lo.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── ACHADO 1a ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_erros   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE u.created_at < v_cutoff
      -- Nunca teve assinatura Stripe paga (inclui usuários Cakto migrados, pois
      -- agora todos estão em stripe_subscriptions com status 'active')
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
      -- [FIX 2026-07-01] NÃO apagar convidados: membro ativo de plano casal/família
      -- acessa pela assinatura do dono e nunca tem assinatura própria.
      AND NOT EXISTS (
        SELECT 1 FROM public.account_members am
        WHERE am.member_user_id = u.id
          AND am.is_active = true
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members      WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members      WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data            WHERE user_id        = v_user_id;
      DELETE FROM public.profiles             WHERE user_id        = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id        = v_user_id;
      DELETE FROM auth.users                  WHERE id             = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_unpaid] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      -- Resiliência por linha preservada: uma conta problemática não trava o ciclo.
      v_erros := v_erros + 1;
      RAISE WARNING '[purge_unpaid] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_unpaid] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  -- ⭐ A CORREÇÃO (2026-08-21): propagar no FIM. Sem isto o job grava `succeeded`
  -- mesmo com 100% de falha e o monitor fica cego para sempre.
  IF v_erros > 0 THEN
    RAISE EXCEPTION '[purge_unpaid] % de % exclusão(ões) falharam — ver os WARNINGs acima',
      v_erros, v_erros + v_count;
  END IF;

  RETURN v_count;
END;
$function$;

-- ── ACHADO 1b ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_erros   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '90 days';
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      -- Sem nenhuma assinatura ativa no mesmo user (inclui vitalícios Cakto migrados)
      AND  NOT EXISTS (
             SELECT 1 FROM public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
      -- GUARDA DE CONVIDADO (M-4): quem é membro ativo do plano de outra pessoa
      -- continua usando o produto e NÃO pode ser excluído por ter cancelado a
      -- própria assinatura no passado.
      AND  NOT EXISTS (
             SELECT 1 FROM public.account_members am
             WHERE  am.member_user_id = s.user_id
               AND  am.is_active = true
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data            WHERE user_id = v_user_id;
      DELETE FROM public.profiles             WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                  WHERE id      = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      v_erros := v_erros + 1;
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  IF v_erros > 0 THEN
    RAISE EXCEPTION '[purge_expired] % de % exclusão(ões) falharam — ver os WARNINGs acima',
      v_erros, v_erros + v_count;
  END IF;

  RETURN v_count;
END;
$function$;

-- ── ACHADO 2 ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.listar_fotos_orfas()
RETURNS TABLE (caminho text, pasta text, criado_em timestamptz, bytes bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
  SELECT o.name,
         (string_to_array(o.name, '/'))[1],
         o.created_at,
         (o.metadata->>'size')::bigint
  FROM storage.objects o
  WHERE o.bucket_id = 'profile-photos'
    -- Só pastas que são UUID. Qualquer outro formato fica de fora: melhor deixar
    -- lixo do que arriscar listar objeto cujo dono não sabemos determinar.
    AND (string_to_array(o.name, '/'))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = ((string_to_array(o.name, '/'))[1])::uuid
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.listar_fotos_orfas() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.listar_fotos_orfas() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.listar_fotos_orfas() TO service_role;

COMMENT ON FUNCTION public.listar_fotos_orfas() IS
  'LGPD art. 16: fotos de titulares já excluídos. storage.objects não tem FK para '
  'auth.users, então nenhuma cascata as alcança e os 3 crons de purga são SQL puro. '
  'Consumida por scripts/purgar-fotos-orfas.mjs, que remove pela Storage API — '
  'apagar a linha aqui deixaria o arquivo órfão no S3.';

COMMIT;
