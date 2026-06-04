-- =============================================================================
-- GranaEvo — Migration: RLS na tabela plans (leitura pública, escrita bloqueada)
--
-- A tabela plans é intencionalmente legível pelo papel anon (preços visíveis
-- na página /planos sem autenticação). Porém, deve ser READONLY — nenhum
-- usuário comum pode inserir, alterar ou deletar planos.
--
-- Esta migration formaliza essa intenção via RLS explícito.
-- =============================================================================

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

-- Leitura pública — qualquer origem pode listar planos (pricing page)
CREATE POLICY "plans_select_public"
  ON public.plans FOR SELECT
  USING (true);

-- Escrita bloqueada para todos exceto service_role (que bypassa RLS)
-- INSERT, UPDATE, DELETE: sem policy = bloqueado por padrão com RLS ativo
