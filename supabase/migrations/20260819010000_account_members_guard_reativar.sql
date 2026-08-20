-- SEC-001d — `account_members.is_active` reativável pelo cliente (assimetria vs SEC-001)
-- ============================================================================
-- Auditoria god-eyes de 2026-08-19. Ver security-audit/god-eyes-REPORT-2026-08-19.md
--
-- O IRMÃO ESQUECIDO DO SEC-001. Em 2026-08-17 fechamos `profiles.is_active`
-- (migration 20260817000000) revogando o grant de coluna: o cliente NUNCA
-- escreve is_active em profiles, então revogar bastou.
--
-- `account_members` ficou de fora — e aqui a solução NÃO pode ser a mesma:
-- o cliente PRECISA escrever is_active=false. Remover um convidado pela interface
-- é um UPDATE direto no PostgREST (src/scripts/pages/db-configuracoes.js:789):
--
--     UPDATE account_members SET is_active=false WHERE id=X AND owner_user_id=me
--
-- Por isso a coluna is_active tem grant `authenticated=w` (verificado 2026-08-19).
-- A policy account_members_update limita às linhas do dono. Mas NENHUM trigger
-- restringe a DIREÇÃO da transição. Logo o dono faz o caminho de volta:
--
--     PATCH /rest/v1/account_members?id=eq.X {"is_active": true}   → 200
--
-- e reativa convidados que o downgrade de plano havia desativado
-- (webhook-stripe desativa em pending_member_removals; o cron
-- granaevo-expire-profile-backups também). get_user_access_data() volta a achar
-- `member_user_id=convidado AND is_active=true` + a assinatura do dono e concede
-- acesso. Resultado: plano Individual mantendo 3 convidados = burla do limite.
--
-- ── POR QUE UM TRIGGER ASSIMÉTRICO, E NÃO REVOKE ─────────────────────────────
-- Revogar UPDATE(is_active) quebraria a remoção de convidado da UI, que é
-- legítima e não passa por RPC nenhuma. A regra certa não é "cliente não escreve
-- is_active"; é "cliente pode DESATIVAR, nunca REATIVAR". Reativar é operação de
-- billing e só acontece por service_role, em dois lugares, ambos verificados:
--
--     verify-guest-invite/index.ts:248  (reconvite)          → supabaseAdmin
--     update-stripe-plan/index.ts:206   (restore de upgrade) → db (service key)
--
-- Sob service_role, auth.uid() é NULL (provado em 2026-08-19:
-- `SELECT auth.uid()` numa conexão sem JWT de usuário devolve NULL). É a MESMA
-- convenção que trg_profiles_guard_is_active já usa em produção. O cron roda como
-- postgres (auth.uid() também NULL) e, de qualquer forma, só faz is_active=false.
--
-- ── BLINDAGEM EM CAMADAS (o cliente teria de furar as quatro) ────────────────
--   1. RLS account_members_update .... USING+CHECK owner_user_id = auth.uid()
--   2. grant por coluna .............. só is_active/member_name (não owner/member_user_id)
--   3. ESTE trigger (direção) ........ false/NULL → true por cliente = 42501
--   4. fluxos de reativação .......... autenticam + autorizam antes do service_role
--
-- ⚠️ ESTE TRIGGER SOME NUM RESTORE via pg_dump só de dados. Ele é DDL, então um
--    pg_dump de schema o traz; mas um restore seletivo de dados não. Mesmo aviso
--    de sincronia do SEC-001.
--
-- IMPACTO FUNCIONAL: ZERO nos fluxos legítimos.
--   • remover convidado (cliente, true→false) ....... PASSA
--   • renomear convidado (member_name, is_active=true→true, sem mudança) . PASSA
--   • reconvite (service_role, false→true) .......... PASSA
--   • restore de upgrade (service_role, false→true) .. PASSA
--   • cron desativa (false) ......................... PASSA
--   Só morre: cliente reativando (false/NULL → true).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_account_members_guard_reativar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    -- Só interessa a transição para ATIVO. Qualquer outra mudança
    -- (desativar, renomear, mexer em removed_at) segue livre.
    IF NEW.is_active IS NOT TRUE THEN
        RETURN NEW;                       -- indo para false/NULL: sempre ok
    END IF;

    IF OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN
        RETURN NEW;                       -- já estava true (ex.: renomear): ok
    END IF;

    -- Aqui: OLD era false/NULL e NEW é true = REATIVAÇÃO.
    -- auth.uid() NOT NULL = cliente autenticado. Reativar é service_role-only.
    IF auth.uid() IS NOT NULL THEN
        RAISE EXCEPTION
          '[SEGURANCA] reativar convidado exige reconvite (verify-guest-invite) ou upgrade (update-stripe-plan)'
          USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_members_guard_reativar ON public.account_members;
CREATE TRIGGER account_members_guard_reativar
    BEFORE UPDATE ON public.account_members
    FOR EACH ROW EXECUTE FUNCTION public.trg_account_members_guard_reativar();

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU (rodar como authenticated, via PostgREST)
--
--   1. Desativar convidado (o caminho da UI) segue vivo:
--      PATCH /rest/v1/account_members?id=eq.<meu_membro> {"is_active":false} → 200
--
--   2. O vetor morre:
--      PATCH /rest/v1/account_members?id=eq.<meu_membro> {"is_active":true}  → 42501 / 403
--
--   3. Renomear NÃO é afetado (is_active não muda):
--      PATCH /rest/v1/account_members?id=eq.<meu_membro> {"member_name":"X"} → 200
--
--   4. Nenhum dono tem mais convidados ativos que o plano permite:
--      SELECT owner_user_id, count(*) FILTER (WHERE is_active) AS ativos
--        FROM public.account_members GROUP BY owner_user_id;
--      (cruzar com o limite de convidados do plano — 0/1/3)
--
-- ROLLBACK: ver supabase/rollbacks/20260819010000_account_members_guard_reativar.down.sql
-- ============================================================================
