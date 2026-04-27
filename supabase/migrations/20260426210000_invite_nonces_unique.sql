-- GranaEvo — Migration: UNIQUE constraint em invite_nonces.nonce
--
-- Problema: verificação de nonce usa check-then-update sem garantia atômica.
-- Dois requests simultâneos com o mesmo nonce podem ambos passar (TOCTOU).
--
-- Solução: UNIQUE constraint força o banco a rejeitar o segundo uso do nonce
-- antes do update. Combinado com o filtro .eq('used', false), o banco garante
-- que apenas um dos requests simultâneos consegue marcar o nonce como usado.
--
-- Nota: um índice parcial (WHERE used = false) seria mais eficiente, mas
-- o Supabase PostgREST não suporta ON CONFLICT com índices parciais via SDK.
-- O UNIQUE simples é suficiente para esta tabela de baixo volume.

CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_nonces_nonce_unique
  ON public.invite_nonces (nonce);
