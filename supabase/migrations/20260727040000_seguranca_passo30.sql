-- 20260727040000_seguranca_passo30.sql
-- GranaEvo — Migration: fecha S-3, S-4, S-5, S-6 e M-4 do Passo 30
-- Rollback: ver 20260727040000_seguranca_passo30.down.sql
-- Origem: auditoria /god-mode + /god-eyes de 2026-07-27.

-- ════════════════════════════════════════════════════════════════════════════
-- S-3 · `user_data_snapshots` expunha o blob e o e-mail via PostgREST
-- ════════════════════════════════════════════════════════════════════════════
-- O comentário da própria tabela diz "Listagem retorna apenas metadados —
-- data_json nunca exposto via API", mas o GRANT era de tabela inteira e a policy
-- `snapshots_select_own` libera a linha: `authenticated` conseguia SELECT em
-- data_json. O blob é AES-256-GCM com chave server-side (por isso MÉDIO e não
-- ALTO), mas a superfície não deveria existir.
-- `user_email` sai junto: é PII em claro e nenhum caminho do cliente precisa dela
-- (o dono do snapshot já é o próprio usuário autenticado).
-- Nenhum código cliente lê esta tabela — só a Edge `user-data-backup`, com
-- service_role, que não passa por GRANT.
REVOKE SELECT ON public.user_data_snapshots FROM authenticated;
GRANT  SELECT (id, user_id, snapshot_date, size_bytes, checksum, created_at)
    ON public.user_data_snapshots TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- S-4 · `terms_acceptance` tinha GRANT de escrita sem policy correspondente
-- ════════════════════════════════════════════════════════════════════════════
-- Hoje o RLS nega, então é inerte — mas é o lado perigoso do desalinhamento:
-- basta alguém criar uma policy `FOR ALL` no futuro e vira escrita livre num
-- registro de CONSENTIMENTO LGPD, que é justamente a prova de que o usuário
-- aceitou os termos. Aceite é imutável por definição; quem grava é a Edge
-- `accept-terms` com service_role.
REVOKE UPDATE, DELETE ON public.terms_acceptance FROM authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- S-5 · Cruft de RLS: policies sem GRANT e tabelas sem FORCE
-- ════════════════════════════════════════════════════════════════════════════
-- As três policies abaixo são inertes (não há GRANT do comando que elas
-- governam), mas cada uma é uma mina para o próximo que mexer no outro lado:
-- conceder o GRANT passaria a valer a policy sem ninguém perceber.
DROP POLICY IF EXISTS "Users can delete own profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile"  ON public.user_profile_management;
DROP POLICY IF EXISTS feature_flags_select_auth       ON public.feature_flags;

-- FORCE faz o RLS valer inclusive para o DONO da tabela. 25 das 28 já tinham;
-- estas três ficaram para trás. Impacto prático baixo (o dono é `postgres`, fora
-- do caminho da API, e as três não têm grant para cliente), mas padrão quebrado
-- em segurança é como se descobre o buraco tarde demais.
ALTER TABLE public.chat_parse_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.edge_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.login_lockouts   FORCE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════════
-- S-6 · Imutabilidade do audit log dependia só de um GUC de sessão
-- ════════════════════════════════════════════════════════════════════════════
-- A guarda liberava DELETE para QUALQUER sessão que conseguisse
-- `SET granaevo.audit_retention='on'` — e GUCs de prefixo customizado são
-- setáveis por qualquer role. Hoje é inalcançável pela API (nem `anon` nem
-- `authenticated` têm GRANT de DELETE), mas uma Edge Function com service_role
-- que fizesse o SET conseguiria zerar o registro financeiro inteiro.
--
-- Agora exige as DUAS coisas: o GUC E ser `postgres`.
-- Seguro para a rotina de retenção: `purge_audit_log_retention` é SECURITY
-- DEFINER e pertence a `postgres` — dentro dela, `current_user` É 'postgres'.
-- (Conferido antes de aplicar: owner=postgres, definer=true. O primeiro DELETE
-- real acontece em 01/08/2026; se esta condição estivesse errada, o cron falharia
-- naquele dia com a tabela já vencida.)
CREATE OR REPLACE FUNCTION public.bloquear_alteracao_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('granaevo.audit_retention', true) = 'on'
     AND current_user = 'postgres'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '[SEGURANCA] Audit log e imutavel. Operacao bloqueada: % na tabela %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- M-4 · `purge_expired_cancelled_accounts` podia apagar convidado ativo
-- ════════════════════════════════════════════════════════════════════════════
-- É a ÚNICA das três purgas sem a guarda de `account_members`. As outras duas
-- (`cleanup_abandoned_accounts` e `purge_unpaid_accounts`) ganharam essa guarda
-- no incidente de 2026-07-01, quando os crons apagaram convidados de plano
-- casal/família que não têm assinatura própria. Esta ficou de fora e reabre o
-- mesmo buraco por outra porta: um ex-titular que cancelou há mais de 90 dias e
-- HOJE é convidado ativo do plano de outra pessoa seria excluído — e o
-- `ON DELETE CASCADE` levaria o vínculo em `account_members` junto.
-- Zero vítimas hoje; risco latente.
CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user_id   UUID;
  v_count     integer := 0;
  v_cutoff    TIMESTAMPTZ := NOW() - INTERVAL '90 days';
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
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$function$;

NOTIFY pgrst, 'reload schema';
