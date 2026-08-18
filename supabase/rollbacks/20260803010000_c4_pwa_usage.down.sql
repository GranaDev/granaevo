-- Rollback do C-4. Some com o contador agregado do PWA.
-- A função primeiro: ela depende da tabela, e dropar a tabela deixaria uma
-- função quebrada apontando para o vazio.
DROP FUNCTION IF EXISTS public.pwa_ping(boolean);
DROP TABLE    IF EXISTS public.pwa_usage;
