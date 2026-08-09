-- ============================================================================
-- S-4 / S-5 / S-6 (= B-5) — e DOIS BUGS VIVOS que o item descrevia ao contrário
-- ============================================================================
-- O item S-5 do mapa 10/10 mandava "DROP das policies sem grant correspondente".
-- Ao medir com `has_table_privilege` (que vê herança e PUBLIC, diferente de
-- `role_table_grants`), sete policies apareceram sem privilégio. Duas delas NÃO
-- eram cruft: eram funcionalidades QUEBRADAS EM PRODUÇÃO, com a policy certa no
-- lugar e o GRANT faltando.
--
--   1. O "X" do sino não dispensa notificação.
--      notificacoes-inbox.js:107 faz UPDATE em radar_notifications.dismissed_at
--      como `authenticated`, que tem DELETE/INSERT/SELECT e NÃO tem UPDATE.
--      O código faz `if (error) return false` — falha calada, o aviso volta.
--      (Já tinha sido detectado na auditoria de 2026-07-27 e nunca corrigido.)
--
--   2. Remover convidado do plano casal/família não funciona.
--      db-configuracoes.js:786 faz UPDATE em account_members.is_active como
--      `authenticated`, que só tem SELECT. Aqui é `throw` — o dono vê erro.
--
-- Ter seguido o item ao pé da letra teria APAGADO as duas policies e cimentado
-- os dois defeitos. É o motivo de a regra ser "prove que o 🔴 ainda é 🔴".
--
-- GRANT POR COLUNA, não por tabela: mesmo com a linha liberada pela policy, o
-- usuário só consegue escrever na coluna que a funcionalidade precisa. As duas
-- policies já restringem a LINHA por dono (USING + WITH CHECK, conferido).
-- ============================================================================

-- ── Bug 1: o X do sino ──────────────────────────────────────────────────────
-- Policy: radar_update_own_dismiss — USING/WITH CHECK `auth.uid() = user_id`.
GRANT UPDATE (dismissed_at) ON public.radar_notifications TO authenticated;

-- ── Bug 2: remover convidado do plano ───────────────────────────────────────
-- Policy: account_members_update — USING/WITH CHECK `owner_user_id = auth.uid()`.
GRANT UPDATE (is_active) ON public.account_members TO authenticated;

-- ── S-5: as cinco que são cruft de verdade ──────────────────────────────────
-- Nenhuma tem chamador no cliente (`grep from('<tabela>')` em src/scripts = 0) e
-- nenhuma tem o GRANT correspondente, então são inalcançáveis. O acesso real a
-- essas tabelas é por Edge Function com service_role, que ignora RLS.
--
-- Apagar é seguro no sentido que importa: se um dia alguém conceder o GRANT sem
-- recriar a policy, o RLS nega por padrão (a tabela fica fechada, não aberta).
DROP POLICY IF EXISTS account_members_insert          ON public.account_members;
DROP POLICY IF EXISTS account_members_delete          ON public.account_members;
DROP POLICY IF EXISTS owner_can_view_own_invitations  ON public.guest_invitations;
DROP POLICY IF EXISTS profile_backups_select_own      ON public.profile_backups;
DROP POLICY IF EXISTS snapshots_select_own            ON public.user_data_snapshots;

-- ── S-4 e S-6: já estavam fechados (verificado em 2026-08-09) ───────────────
-- S-4: `authenticated` em terms_acceptance já tem só INSERT e SELECT — o
--      REVOKE de UPDATE/DELETE já havia sido aplicado.
-- S-6: `bloquear_alteracao_audit_log` já contém `AND current_user = 'postgres'`
--      na exceção de retenção.
-- Nada a fazer. Registrado aqui para a próxima auditoria não reabrir.
