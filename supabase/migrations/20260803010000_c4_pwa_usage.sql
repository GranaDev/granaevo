-- C-4 — medir a instalação real do PWA, SEM criar dado pessoal
-- ===========================================================================
-- A PERGUNTA QUE ISTO RESPONDE
--   "Vale investir mais no PWA do assistente?" Hoje não há resposta: o módulo
--   `install.js` sabe detectar instalação (`isStandalone`) e sabe o desfecho do
--   convite (`accepted`/`dismissed`/…), mas ninguém CONTA nada — e o que fosse
--   contado no aparelho ficaria no aparelho, invisível para quem decide.
--
-- POR QUE SEM user_id
--   Guardar "o usuário X abriu o app instalado no dia Y" seria telemetria de uso
--   ligada a uma pessoa — dado pessoal, que exigiria declarar na Política e no
--   RoPA (acabamos de fechar esse capítulo em 2026-08-03) e daria ao dono um
--   histórico de comportamento que ele não precisa.
--
--   A decisão só precisa de uma PROPORÇÃO: de cada 100 aberturas do assistente,
--   quantas vêm de um app instalado. Isso é agregado puro. Sem user_id, sem
--   device, sem IP — nada aqui aponta para ninguém, então não é dado pessoal e
--   não há o que declarar.
--
--   Contar por DIA (e não um total) permite ver tendência, que é o que responde
--   "está crescendo?" — a pergunta real por trás de "vale investir".
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pwa_usage (
  day         date PRIMARY KEY,
  standalone  integer NOT NULL DEFAULT 0 CHECK (standalone >= 0),
  navegador   integer NOT NULL DEFAULT 0 CHECK (navegador  >= 0)
);

COMMENT ON TABLE public.pwa_usage IS
  'C-4: contagem AGREGADA de aberturas do assistente por dia (instalado x navegador). '
  'Sem user_id/device/IP de propósito — não é dado pessoal e não requer declaração LGPD.';

ALTER TABLE public.pwa_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwa_usage FORCE ROW LEVEL SECURITY;

-- Nenhuma policy para `authenticated` ou `anon`: ninguém lê nem escreve direto.
-- A escrita passa pela RPC SECURITY DEFINER abaixo; a leitura é do dono, pelo
-- painel/SQL. Tabela sem policy com RLS ligado é FECHADA, que é o desejado.
REVOKE ALL ON public.pwa_usage FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC de incremento. SECURITY DEFINER porque a tabela é fechada.
-- Recebe só um booleano — não há como um chamador injetar identidade aqui,
-- porque a função não aceita nem grava nenhuma.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwa_ping(p_standalone boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.pwa_usage AS u (day, standalone, navegador)
  VALUES (
    (now() AT TIME ZONE 'utc')::date,
    CASE WHEN p_standalone THEN 1 ELSE 0 END,
    CASE WHEN p_standalone THEN 0 ELSE 1 END
  )
  ON CONFLICT (day) DO UPDATE
    SET standalone = u.standalone + CASE WHEN p_standalone THEN 1 ELSE 0 END,
        navegador  = u.navegador  + CASE WHEN p_standalone THEN 0 ELSE 1 END;

  -- Higiene: 180 dias bastam para ver tendência. Sem isso a tabela cresce para
  -- sempre guardando número que ninguém mais consulta.
  DELETE FROM public.pwa_usage WHERE day < (now() AT TIME ZONE 'utc')::date - 180;
END;
$$;

-- Só o service_role executa: quem chama é a rota autenticada do servidor, nunca
-- o cliente. Sem isto, `authenticated` herdaria EXECUTE do PUBLIC e qualquer um
-- poderia inflar o contador direto do navegador.
REVOKE ALL     ON FUNCTION public.pwa_ping(boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.pwa_ping(boolean) TO service_role;
