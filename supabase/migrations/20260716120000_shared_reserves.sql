-- ============================================================================
-- Reserva compartilhada da família (item 13)
--
-- POR QUE UMA TABELA NOVA, E NÃO O BLOB:
-- Todo dado financeiro do app vive em `user_data.data_json` (um blob por conta).
-- O convidado LÊ o blob do dono (política `user_data_select` já permite via
-- account_members), mas NÃO escreve: `user_data_update` é `auth.uid() = user_id`,
-- e a escrita do convidado só acontece através de /api/user-data, que roda com
-- service_role e resolve o dono no servidor. Ou seja: no blob, uma reserva
-- compartilhada seria read-only para quem não é o dono — e a regra do produto é
-- que TODOS colocam e tiram. Daí a tabela própria, com RLS por account_members.
--
-- SALDO É DERIVADO, NUNCA ARMAZENADO:
-- saldo = Σ(aporte) − Σ(retirada). Guardar um `saldo` na reserva criaria duas
-- fontes de verdade que divergem no primeiro erro de rede — e o valor errado
-- seria invisível (ninguém confere soma de 200 movimentos na mão). Derivar é
-- mais lento e sempre certo; é dinheiro de família, tem que fechar.
--
-- A TRILHA É O PRODUTO:
-- o pedido não é "reserva compartilhada", é "sempre mostrando QUEM colocou e
-- QUEM retirou". Por isso `shared_reserve_movements` é um livro-razão: sem
-- UPDATE para ninguém, e DELETE só do PRÓPRIO movimento e só nos primeiros 10
-- minutos (desfazer um erro de digitação). Passou disso, é imutável — quem
-- pudesse apagar o próprio saque em silêncio quebraria a única promessa da
-- feature. Para corrigir depois, lança-se o movimento contrário, como em
-- qualquer razão contábil de verdade.
-- ============================================================================

-- ── Tabela: a reserva ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shared_reserves (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- A conta dona. Para o titular = seu próprio id; para o convidado é o id do
    -- titular (o mesmo `effectiveUserId` que o app já usa para carregar o blob).
    owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    nome          text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 60),
    objetivo      numeric(12,2) CHECK (objetivo IS NULL OR (objetivo > 0 AND objetivo <= 100000000)),
    -- Quem criou. ON DELETE SET NULL: se essa pessoa sair da família, a reserva
    -- continua — ela é da CONTA, não de quem clicou primeiro.
    created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz
);

COMMENT ON TABLE public.shared_reserves IS
    'Reserva compartilhada da conta (plano casal/família). Saldo NÃO fica aqui: é derivado de shared_reserve_movements.';

-- ── Tabela: o livro-razão ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shared_reserve_movements (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reserve_id     uuid NOT NULL REFERENCES public.shared_reserves(id) ON DELETE CASCADE,
    -- Desnormalizado de propósito: a política de RLS filtra por conta sem
    -- precisar de JOIN com shared_reserves (que teria o próprio RLS aplicado).
    -- O trigger abaixo garante que casa com a reserva — o cliente não escolhe.
    owner_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- QUEM fez. SET NULL na exclusão da conta (LGPD): o movimento sobrevive para
    -- o saldo continuar fechando, mas o vínculo com a pessoa é cortado.
    member_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    -- Nome no MOMENTO do movimento. É snapshot porque a trilha precisa dizer
    -- "quem foi" mesmo depois de a pessoa trocar de nome ou sair da família.
    member_name    text NOT NULL CHECK (length(btrim(member_name)) BETWEEN 1 AND 80),
    tipo           text NOT NULL CHECK (tipo IN ('aporte', 'retirada')),
    valor          numeric(12,2) NOT NULL CHECK (valor > 0 AND valor <= 10000000),
    nota           text CHECK (nota IS NULL OR length(nota) <= 140),
    created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.shared_reserve_movements IS
    'Livro-razão da reserva compartilhada: imutável (sem UPDATE; DELETE só do próprio, ate 10 min). Saldo = SUM(aporte) - SUM(retirada).';

CREATE INDEX IF NOT EXISTS idx_shared_reserves_owner
    ON public.shared_reserves (owner_user_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_srm_reserve
    ON public.shared_reserve_movements (reserve_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_srm_owner
    ON public.shared_reserve_movements (owner_user_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.shared_reserves          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_reserve_movements ENABLE ROW LEVEL SECURITY;

-- Predicado de pertencimento, repetido inline em cada política.
--
-- NÃO usa SECURITY DEFINER de propósito: a subconsulta em account_members roda
-- sob o RLS do chamador, e a política `member_can_read_own_membership` já deixa
-- o membro enxergar a PRÓPRIA linha — então o EXISTS resolve. É exatamente o
-- mesmo padrão que `user_data_select` usa hoje em produção. Uma função DEFINER
-- aqui só adicionaria superfície de escalada de privilégio sem ganho nenhum.

-- SELECT: titular e membros ativos veem as reservas da conta.
CREATE POLICY "shared_reserves_select" ON public.shared_reserves
    FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = owner_user_id
        OR EXISTS (
            SELECT 1 FROM public.account_members am
            WHERE am.owner_user_id  = shared_reserves.owner_user_id
              AND am.member_user_id = (SELECT auth.uid())
              AND am.is_active      = true
        )
    );

-- INSERT: qualquer membro ativo cria (é reserva da família, não do dono).
-- `created_by` é forçado a ser o próprio autor — sem isso dava para forjar autoria.
CREATE POLICY "shared_reserves_insert" ON public.shared_reserves
    FOR INSERT TO authenticated
    WITH CHECK (
        created_by = (SELECT auth.uid())
        AND (
            (SELECT auth.uid()) = owner_user_id
            OR EXISTS (
                SELECT 1 FROM public.account_members am
                WHERE am.owner_user_id  = shared_reserves.owner_user_id
                  AND am.member_user_id = (SELECT auth.uid())
                  AND am.is_active      = true
            )
        )
    );

-- UPDATE: só o TITULAR renomeia/arquiva. Membro movimenta dinheiro, mas não
-- mexe na estrutura — arquivar a reserva dos outros não é operação de convidado.
-- WITH CHECK obrigatório: sem ele o titular poderia reatribuir owner_user_id e
-- empurrar a reserva para outra conta.
CREATE POLICY "shared_reserves_update" ON public.shared_reserves
    FOR UPDATE TO authenticated
    USING       ((SELECT auth.uid()) = owner_user_id)
    WITH CHECK  ((SELECT auth.uid()) = owner_user_id);

-- DELETE: idem — só o titular.
CREATE POLICY "shared_reserves_delete" ON public.shared_reserves
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = owner_user_id);

-- SELECT dos movimentos: mesma regra de pertencimento. É o coração da feature —
-- todo mundo enxerga o que todo mundo fez.
CREATE POLICY "srm_select" ON public.shared_reserve_movements
    FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = owner_user_id
        OR EXISTS (
            SELECT 1 FROM public.account_members am
            WHERE am.owner_user_id  = shared_reserve_movements.owner_user_id
              AND am.member_user_id = (SELECT auth.uid())
              AND am.is_active      = true
        )
    );

-- INSERT: membro ativo lança, e SÓ EM SEU PRÓPRIO NOME.
-- `member_user_id = auth.uid()` é a trava anti-falsificação: sem ela, alguém
-- poderia registrar "a Maria sacou R$500" — e a trilha, que é o produto inteiro,
-- viraria ficção.
CREATE POLICY "srm_insert" ON public.shared_reserve_movements
    FOR INSERT TO authenticated
    WITH CHECK (
        member_user_id = (SELECT auth.uid())
        AND (
            (SELECT auth.uid()) = owner_user_id
            OR EXISTS (
                SELECT 1 FROM public.account_members am
                WHERE am.owner_user_id  = shared_reserve_movements.owner_user_id
                  AND am.member_user_id = (SELECT auth.uid())
                  AND am.is_active      = true
            )
        )
    );

-- Sem política de UPDATE: o razão é imutável. Ausência de política = negado.

-- DELETE: só o próprio movimento e só nos 10 primeiros minutos (desfazer erro de
-- digitação). Depois disso nem o titular apaga — inclusive o titular, de novo por
-- design: se o dono pudesse apagar o próprio saque, "quem retirou" não valeria nada.
CREATE POLICY "srm_delete_recente_proprio" ON public.shared_reserve_movements
    FOR DELETE TO authenticated
    USING (
        member_user_id = (SELECT auth.uid())
        AND created_at > (now() - interval '10 minutes')
    );

-- ── Integridade: o cliente não escolhe a conta nem a data ───────────────────
-- owner_user_id do movimento é COPIADO da reserva, não aceito do payload. Sem
-- isto, um membro legítimo da conta A poderia inserir um movimento apontando
-- para uma reserva da conta B: o WITH CHECK olha o owner_user_id que veio na
-- linha (que passaria, é a conta dele), mas o reserve_id apontaria para fora.
CREATE OR REPLACE FUNCTION public.srm_forcar_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner uuid;
    v_saldo numeric(12,2);
BEGIN
    -- Serializa os movimentos da MESMA reserva: sem lock, dois saques simultâneos
    -- leriam o mesmo saldo e ambos passariam, deixando a reserva negativa.
    -- Advisory lock e NÃO `SELECT ... FOR UPDATE`: FOR UPDATE exige privilégio de
    -- UPDATE na linha, que o convidado não tem (a política de UPDATE é só do
    -- titular) — o lock travaria justamente quem a feature existe para atender.
    -- Colisão de hash só serializa reservas distintas à toa; é barato.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.reserve_id::text)::bigint);

    -- Esta função é SECURITY INVOKER de propósito: o SELECT abaixo roda sob o RLS
    -- do chamador. Quem não enxerga a reserva cai em NOT FOUND — o que torna a
    -- barreira independente da ordem entre trigger e WITH CHECK (no Postgres o
    -- BEFORE ROW trigger roda ANTES do WITH CHECK, mas não dependemos disso).
    SELECT owner_user_id INTO v_owner
    FROM public.shared_reserves
    WHERE id = NEW.reserve_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'reserva inexistente';
    END IF;

    NEW.owner_user_id := v_owner;   -- ignora o que veio do cliente
    NEW.created_at    := now();     -- idem: a janela de 10 min do DELETE depende disto

    IF NEW.tipo = 'retirada' THEN
        SELECT COALESCE(SUM(CASE WHEN tipo = 'aporte' THEN valor ELSE -valor END), 0)
        INTO v_saldo
        FROM public.shared_reserve_movements
        WHERE reserve_id = NEW.reserve_id;

        IF v_saldo < NEW.valor THEN
            RAISE EXCEPTION 'saldo insuficiente na reserva compartilhada';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_srm_forcar_owner
    BEFORE INSERT ON public.shared_reserve_movements
    FOR EACH ROW EXECUTE FUNCTION public.srm_forcar_owner();

-- Teto de reservas por conta — o cliente não é fonte de verdade para limite.
CREATE OR REPLACE FUNCTION public.shared_reserves_limite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n integer;
BEGIN
    SELECT count(*) INTO v_n
    FROM public.shared_reserves
    WHERE owner_user_id = NEW.owner_user_id
      AND archived_at IS NULL;

    IF v_n >= 5 THEN
        RAISE EXCEPTION 'limite de 5 reservas compartilhadas por conta atingido';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_shared_reserves_limite
    BEFORE INSERT ON public.shared_reserves
    FOR EACH ROW EXECUTE FUNCTION public.shared_reserves_limite();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- anon NÃO recebe nada: sem grant + RLS = duas barreiras.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shared_reserves          TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.shared_reserve_movements TO authenticated;
-- Sem UPDATE no razão nem no grant: defesa em profundidade (grant + ausência de política).
