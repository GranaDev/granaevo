#!/usr/bin/env node
/**
 * GranaEvo — valida um banco RESTAURADO antes de declará-lo utilizável.
 *
 * USO:
 *   node scripts/verificar-restore.mjs --ref <project_ref_do_destino>
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 * Em 2026-08-12 o primeiro restore de verdade terminou com `pg_restore` exit 0
 * e um banco MUITO mais aberto que a produção:
 *
 *     SECURITY DEFINER expostas a anon/authenticated ...  2  →  34
 *     tabelas com escrita para authenticated ...........  4  →  28
 *
 * O `anon`, sem login, executava `salvar_dados_usuario` e
 * `revogar_sessoes_usuario`. Ou seja: **pg_restore concluído ≠ estado seguro
 * restaurado**. Quem parasse no exit 0 colocaria no ar um banco furado.
 *
 * As asserções abaixo são INVARIANTES ABSOLUTAS, não comparação com a produção
 * — de propósito. Num desastre de verdade a produção não está lá para comparar.
 *
 * Sai com código != 0 se qualquer uma falhar. Restore não validado é restore
 * que não aconteceu.
 */

const args = process.argv.slice(2);
const REF = args[args.indexOf('--ref') + 1];
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!REF || REF.startsWith('--')) {
    console.error('uso: node scripts/verificar-restore.mjs --ref <project_ref>');
    process.exit(2);
}
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN ausente'); process.exit(2); }

async function sql(query) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
}

// `can_create_profile` e `mfa_pendente` são avaliadas DENTRO de policies — o
// papel que dispara a query precisa poder executá-las. As duas só falam do
// próprio auth.uid() e não escrevem nada.
const DEFINER_PERMITIDAS = ['can_create_profile', 'mfa_pendente'];

const checagens = [
    {
        nome: 'RLS habilitado em todas as tabelas de public',
        q: `SELECT count(*) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;`,
        ok: (v) => v === 0, esperado: '0 tabelas sem RLS',
    },
    {
        nome: 'FORCE RLS em todas as tabelas de public',
        q: `SELECT count(*) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relforcerowsecurity;`,
        ok: (v) => v === 0, esperado: '0 tabelas sem FORCE',
    },
    {
        nome: 'nenhuma SECURITY DEFINER executável por anon',
        q: `SELECT count(*) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prokind='f' AND p.prosecdef
              AND pg_get_function_result(p.oid) <> 'trigger'
              AND has_function_privilege('anon', p.oid, 'EXECUTE');`,
        ok: (v) => v === 0, esperado: '0',
    },
    {
        nome: 'SECURITY DEFINER p/ authenticated só as da allow-list',
        q: `SELECT count(*) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prokind='f' AND p.prosecdef
              AND pg_get_function_result(p.oid) <> 'trigger'
              AND p.proname NOT IN (${DEFINER_PERMITIDAS.map((f) => `'${f}'`).join(',')})
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE');`,
        ok: (v) => v === 0, esperado: '0 fora da allow-list',
    },
    {
        nome: 'user_data: authenticated LÊ',
        q: `SELECT has_table_privilege('authenticated','public.user_data','SELECT')::int AS v;`,
        ok: (v) => v === 1, esperado: 'true',
    },
    {
        nome: 'user_data: authenticated NÃO escreve (SEC-009)',
        q: `SELECT (has_table_privilege('authenticated','public.user_data','INSERT')
                 OR has_table_privilege('authenticated','public.user_data','UPDATE')
                 OR has_table_privilege('authenticated','public.user_data','DELETE'))::int AS v;`,
        ok: (v) => v === 0, esperado: 'false',
    },
    {
        nome: 'tabelas graváveis por authenticated (esperado ≤ 4)',
        q: `SELECT count(*) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r'
              AND (has_table_privilege('authenticated',c.oid,'INSERT')
                OR has_table_privilege('authenticated',c.oid,'UPDATE')
                OR has_table_privilege('authenticated',c.oid,'DELETE'));`,
        ok: (v) => v <= 4, esperado: '≤ 4',
    },
    {
        nome: 'policies presentes',
        q: `SELECT count(*) AS v FROM pg_policies WHERE schemaname='public';`,
        ok: (v) => v >= 50, esperado: '≥ 50',
    },
    {
        nome: 'toda função de public tem search_path fixo',
        q: `SELECT count(*) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prokind='f' AND p.proconfig IS NULL;`,
        ok: (v) => v === 0, esperado: '0 sem search_path',
    },
    {
        nome: 'auth.users tem gente (senão não há login)',
        q: `SELECT count(*) AS v FROM auth.users;`,
        ok: (v) => v > 0, esperado: '> 0',
    },
    {
        nome: 'auth.identities pareado com auth.users',
        q: `SELECT (SELECT count(*) FROM auth.users) - (SELECT count(*) FROM auth.identities) AS v;`,
        ok: (v) => v === 0, esperado: '0 de diferença',
    },
    {
        nome: 'dados financeiros presentes',
        q: `SELECT count(*) AS v FROM public.user_data;`,
        ok: (v) => v > 0, esperado: '> 0',
    },
];

console.log(`[verificar-restore] destino: ${REF}\n`);
let falhas = 0;

for (const c of checagens) {
    let valor, erro = null;
    try { valor = Number((await sql(c.q))[0].v); }
    catch (e) { erro = e.message; }

    if (erro) {
        falhas++;
        console.log(`  ERRO   ${c.nome.padEnd(52)} ${erro.slice(0, 60)}`);
        continue;
    }
    const passou = c.ok(valor);
    if (!passou) falhas++;
    console.log(`  ${passou ? 'ok  ' : 'FALHA'}   ${c.nome.padEnd(52)} ${String(valor).padEnd(8)} (esperado ${c.esperado})`);
}

console.log('');
if (falhas) {
    console.log(`[verificar-restore] RESTORE REPROVADO — ${falhas} checagem(ns) falharam.`);
    console.log('[verificar-restore] Provavelmente falta aplicar o granaevo-<ts>.privilegios.sql.');
    console.log('[verificar-restore] NÃO coloque este banco no ar.');
    process.exit(1);
}
console.log(`[verificar-restore] APROVADO — ${checagens.length} checagens passaram.`);
