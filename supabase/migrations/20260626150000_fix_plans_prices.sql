-- =============================================================================
-- GranaEvo — Corrige preços da tabela plans p/ bater com a seção de planos
-- Rollback: ver 20260626150000_fix_plans_prices.down.sql
--
-- A tabela plans tinha preços defasados (Casal 29.99 / Família 49.99) divergentes
-- do padrão exibido ao usuário (planos.html / planos.js): Individual R$19,99,
-- Casal R$34,99, Família R$54,99. (A cobrança real é via Stripe; a tabela plans é
-- referência interna — alinhada aqui para evitar inconsistência futura.)
-- Match de "Família" por LIKE 'Fam%' por segurança de encoding do acento.
-- =============================================================================

UPDATE public.plans SET price = '19.99' WHERE name = 'Individual';
UPDATE public.plans SET price = '34.99' WHERE name = 'Casal';
UPDATE public.plans SET price = '54.99' WHERE name LIKE 'Fam%' AND max_profiles = 4;
