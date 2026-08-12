/**
 * Gera um SQL que RECONSTRÓI o estado exato de privilégios do schema public.
 *
 * ─── POR QUE ISTO PRECISA EXISTIR ───────────────────────────────────────────
 * Descoberto em 2026-08-12, no primeiro teste de restore de verdade:
 *
 *     SECURITY DEFINER expostas a anon/authenticated ....  prod 2  →  restaurado 34
 *     tabelas com escrita para authenticated ............  prod 4  →  restaurado 28
 *
 * No ambiente restaurado o `anon` executava `salvar_dados_usuario`,
 * `revogar_sessoes_usuario` e todas as `purge_*`; o `authenticated` apagava
 * `password_reset_codes` e `financial_audit_log`. Meses de hardening sumiam.
 *
 * A causa é a interação de duas coisas, e nenhuma delas é bug:
 *   1. `pg_dump` só emite GRANT. Do ponto de vista dele um objeto recém-criado
 *      não tem privilégio nenhum, então basta conceder — ele nunca emite o
 *      REVOKE que representa "isto foi tirado de propósito".
 *   2. O Supabase tem ALTER DEFAULT PRIVILEGES que concedem acesso a
 *      anon/authenticated/PUBLIC no momento do CREATE. (E `postgres` não
 *      consegue nem restaurá-los: "permission denied to change default
 *      privileges" — eles pertencem ao supabase_admin.)
 *
 * Somando: o CREATE concede tudo, o GRANT do dump acrescenta, e o REVOKE nunca
 * chega. Toda correção de segurança feita por REVOKE é silenciosamente desfeita.
 *
 * A saída daqui é IDEMPOTENTE por construção: revoga tudo de anon/authenticated
 * /PUBLIC e reconcede exatamente o que a produção tinha. Aplicar duas vezes dá
 * no mesmo; aplicar num banco com defaults frouxos conserta.
 */

/** SQL que, rodado na origem, devolve as linhas do script de privilégios. */
export const CONSULTA_PRIVILEGIOS = `
WITH tabelas AS (
  SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS obj
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
),
funcoes AS (
  SELECT p.oid, format('%I.%I(%s)', n.nspname, p.proname,
                       pg_get_function_identity_arguments(p.oid)) AS obj
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
),
-- Privilegios de tabela que anon/authenticated REALMENTE possuem hoje.
tab_grants AS (
  SELECT t.obj, r.rolname,
         string_agg(pr.priv, ', ' ORDER BY pr.priv) AS privs
  FROM tabelas t
  CROSS JOIN (VALUES ('anon'),('authenticated')) AS r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) AS pr(priv)
  WHERE has_table_privilege(r.rolname, t.oid, pr.priv)
  GROUP BY t.obj, r.rolname
),
fun_grants AS (
  SELECT f.obj, r.rolname
  FROM funcoes f
  CROSS JOIN (VALUES ('anon'),('authenticated')) AS r(rolname)
  WHERE has_function_privilege(r.rolname, f.oid, 'EXECUTE')
),
-- Grants por COLUNA (o projeto usa em account_members e radar_notifications).
col_grants AS (
  SELECT format('%I.%I', c.relname, a.attname) AS dummy,
         format('GRANT %s (%I) ON TABLE public.%I TO %I;',
                pr.priv, a.attname, c.relname, r.rolname) AS linha
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('anon'),('authenticated')) AS r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) AS pr(priv)
  WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attacl IS NOT NULL
    AND has_column_privilege(r.rolname, c.oid, a.attnum, pr.priv)
    AND NOT has_table_privilege(r.rolname, c.oid, pr.priv)
)
SELECT linha, ord FROM (
  -- 1. zera tudo
  SELECT format('REVOKE ALL ON TABLE public.%s FROM anon, authenticated;',
                split_part(obj, '.', 2)) AS linha, 1 AS ord FROM tabelas
  UNION ALL
  SELECT format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated;',
                split_part(obj, '.', 2)) AS linha, 2 AS ord FROM funcoes
  UNION ALL
  -- 2. reconcede exatamente o que a producao tem
  SELECT format('GRANT %s ON TABLE public.%s TO %I;',
                privs, split_part(obj, '.', 2), rolname), 3 FROM tab_grants
  UNION ALL
  SELECT linha, 4 FROM col_grants
  UNION ALL
  SELECT format('GRANT EXECUTE ON FUNCTION public.%s TO %I;',
                split_part(obj, '.', 2), rolname), 5 FROM fun_grants
) x ORDER BY ord, linha;
`;

/** Monta o arquivo .sql final a partir das linhas devolvidas pela consulta. */
export function montarScript(linhas, meta = {}) {
    const cabecalho = [
        '-- GranaEvo — estado de privilégios do schema public',
        `-- Gerado em ${new Date().toISOString()} a partir da produção.`,
        meta.origem ? `-- Origem: ${meta.origem}` : '',
        '--',
        '-- APLICAR SEMPRE DEPOIS DE UM pg_restore. Sem isto, o banco restaurado',
        '-- fica MUITO mais aberto que a produção: o pg_dump só emite GRANT, e os',
        '-- ALTER DEFAULT PRIVILEGES do Supabase concedem acesso a anon/authenticated',
        '-- no CREATE. Medido em 2026-08-12: 2 -> 34 SECURITY DEFINER expostas e',
        '-- 4 -> 28 tabelas com escrita, num restore sem este arquivo.',
        '--',
        '-- Idempotente: revoga tudo e reconcede só o que a produção tinha.',
        '',
        'BEGIN;',
        '',
    ].filter(Boolean);
    return [...cabecalho, ...linhas, '', 'COMMIT;', ''].join('\n');
}
