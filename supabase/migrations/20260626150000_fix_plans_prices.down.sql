-- =============================================================================
-- GranaEvo — Rollback: 20260626150000_fix_plans_prices.sql
-- Restaura os preços anteriores (defasados) da tabela plans. Normalmente NÃO usar.
-- =============================================================================

UPDATE public.plans SET price = '29.99' WHERE name = 'Casal';
UPDATE public.plans SET price = '49.99' WHERE name LIKE 'Fam%' AND max_profiles = 4;
