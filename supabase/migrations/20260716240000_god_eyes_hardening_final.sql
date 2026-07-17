-- ============================================================================
-- /god-eyes 2026-07-16 — hardening final (achados BAIXOS do auditor de RLS)
-- Complementa 20260716230000 (que já fechou os 2 MÉDIOS de concorrência).
-- ============================================================================

-- ── A4: FORCE RLS nas 2 tabelas criadas hoje ───────────────────────────────
-- 23 das 28 tabelas já têm; estas nasceram sem. Sem FORCE, o DONO da tabela
-- (postgres) ignora RLS — o que é esperado, mas o valor é o padrão: quando 23
-- tabelas têm e 2 não, a exceção é sempre lida como esquecimento, não decisão.
ALTER TABLE public.shared_reserves          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_reserve_movements FORCE ROW LEVEL SECURITY;

-- ── A7 + A6: o dono podia trocar o OCUPANTE do assento ─────────────────────
-- `owner_can_manage_own_members` é FOR ALL e o WITH CHECK só pina
-- `owner_user_id = auth.uid()`. `member_user_id` ficava livre: o dono trocava o
-- uuid do membro por outro qualquer, cedendo acesso à própria conta SEM passar
-- pelo fluxo de convite (guest_invitations, com código por e-mail e expiração).
--
-- Fecha JUNTO o A6: com `member_user_id` imutável pelo cliente, ninguém se
-- auto-inscreve como membro da própria conta para satisfazer o EXISTS de
-- `guest_can_insert_owner_profiles` e contornar `can_create_profile()`.
--
-- Grant por COLUNA em vez de mexer na policy: o cliente só precisa de
-- `is_active` (db-configuracoes.js:713 `.update({ is_active: false })` — único
-- UPDATE que o app faz nesta tabela). `member_name` fica editável por ser
-- rótulo. O resto (member_user_id, member_email, owner_*, invitation_id, datas)
-- passa a ser exclusivo do service_role, que é quem processa o convite.
REVOKE UPDATE ON public.account_members FROM authenticated;
GRANT  UPDATE (is_active, member_name) ON public.account_members TO authenticated;

-- ── A8: policies de radar_notifications com role `public` em vez de `authenticated`
-- `public` inclui `anon`. Hoje anon não tem grant nenhum nesta tabela, então não
-- há brecha — mas o grant não pode ser a ÚNICA barreira: se alguém conceder
-- SELECT a anon amanhã, estas 3 policies passam a valer para ele em silêncio.
-- Defesa em profundidade = a policy também precisa dizer quem.
DROP POLICY IF EXISTS "radar_select_own"         ON public.radar_notifications;
DROP POLICY IF EXISTS "radar_insert_own"         ON public.radar_notifications;
DROP POLICY IF EXISTS "radar_delete_own_pending" ON public.radar_notifications;

CREATE POLICY "radar_select_own" ON public.radar_notifications
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "radar_insert_own" ON public.radar_notifications
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id AND status = 'pending');

CREATE POLICY "radar_delete_own_pending" ON public.radar_notifications
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = user_id AND status = 'pending');

-- ── A10: promove o CHECK de NOT VALID para validado ────────────────────────
-- `NOT VALID` só pula as linhas que JÁ existiam. Censo: 0 linhas violam hoje,
-- então validar é grátis e fecha o buraco do legado.
ALTER TABLE public.stripe_subscriptions VALIDATE CONSTRAINT stripe_sub_ativa_exige_periodo;

-- ── LGPD A3: nome perpétuo na trilha da reserva ────────────────────────────
-- `member_user_id` é ON DELETE SET NULL, mas `member_name` (snapshot) ficava
-- para sempre — inclusive de quem exerceu o direito de eliminação (art. 18, VI).
-- SET NULL no id NÃO anonimiza: o nome continua identificando a pessoa.
--
-- A trilha em si se sustenta (legítimo interesse, art. 7º IX: quem põe dinheiro
-- numa reserva de família espera que fique registrado quem pôs). O NOME de quem
-- saiu, não. Trigger anonimiza no momento em que o vínculo é cortado.
--
-- Feito AGORA porque `shared_reserve_movements` tem 0 linhas: custo zero hoje,
-- migração de saldo depois.
CREATE OR REPLACE FUNCTION public.srm_anonimizar_membro_excluido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Dispara quando o FK ON DELETE SET NULL corta o vínculo (exclusão de conta).
    -- O movimento sobrevive para o saldo fechar; a identidade some.
    IF OLD.member_user_id IS NOT NULL AND NEW.member_user_id IS NULL THEN
        NEW.member_name := 'Membro removido';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_srm_anonimizar_membro ON public.shared_reserve_movements;
CREATE TRIGGER trg_srm_anonimizar_membro
    BEFORE UPDATE ON public.shared_reserve_movements
    FOR EACH ROW EXECUTE FUNCTION public.srm_anonimizar_membro_excluido();

COMMENT ON FUNCTION public.srm_anonimizar_membro_excluido() IS
    'LGPD art.18,VI: ON DELETE SET NULL corta o id mas o snapshot member_name identificava a pessoa para sempre. Anonimiza quando o vinculo cai. Achado /god-eyes 2026-07-16.';
