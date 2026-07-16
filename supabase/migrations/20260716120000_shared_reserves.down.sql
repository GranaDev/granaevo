-- Rollback de 20260716120000_shared_reserves.sql
--
-- ⚠️ DESTRUTIVO: apaga as reservas compartilhadas e todo o livro-razão. Os
-- movimentos NÃO existem em nenhum outro lugar (o blob user_data não tem cópia).
-- Antes de rodar em produção, exportar:
--   COPY (SELECT * FROM public.shared_reserve_movements) TO STDOUT WITH CSV HEADER;

DROP TRIGGER  IF EXISTS trg_shared_reserves_limite ON public.shared_reserves;
DROP TRIGGER  IF EXISTS trg_srm_forcar_owner       ON public.shared_reserve_movements;
DROP FUNCTION IF EXISTS public.shared_reserves_limite();
DROP FUNCTION IF EXISTS public.srm_forcar_owner();

-- As políticas caem junto com as tabelas; DROP explícito só por clareza de intenção.
DROP TABLE IF EXISTS public.shared_reserve_movements;
DROP TABLE IF EXISTS public.shared_reserves;
