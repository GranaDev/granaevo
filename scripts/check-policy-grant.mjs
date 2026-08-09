#!/usr/bin/env node
// scripts/check-policy-grant.mjs — policy sem GRANT é bug, não é cruft.
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTE SCRIPT EXISTE (2026-08-09)
// Uma auditoria de 27/07 achou "policies mortas" e mandou APAGÁ-LAS. Ao medir,
// duas das sete não eram cruft — eram FUNCIONALIDADES QUEBRADAS em produção,
// com a policy certa no lugar e o GRANT faltando:
//
//   · o "X" do sino não dispensava notificação (UPDATE em dismissed_at)
//   · remover convidado do plano não funcionava (UPDATE em is_active)
//
// Uma delas já tinha sido detectada em 27/07 e ficou quebrada mais de dez dias.
// Nenhum teste pegava, porque o defeito não está no código nem no banco
// isoladamente — está na COMBINAÇÃO: o cliente chama, a policy permite a linha,
// e o privilégio não existe. O erro volta como 403 e o cliente engole.
//
// ⚠️ POR QUE `role_table_grants` NÃO SERVE
// Ele lista grants de TABELA. Um grant por COLUNA não aparece lá — foi assim
// que `account_members.member_name` (que tinha grant) passou despercebido ao
// lado de `is_active` (que não tinha). Aqui se usa `has_table_privilege` e
// `has_any_column_privilege`, que enxergam tabela, coluna, herança e PUBLIC.
//
// ⚠️⚠️ O QUE ESTE SCRIPT **NÃO** PEGA — e é metade do defeito que o originou.
// Ele responde "o role consegue exercer este comando nesta tabela?". Não
// responde "consegue exercer NA COLUNA que o cliente precisa?".
//
// Provado por mutação em 2026-08-09: revogando `UPDATE (is_active)` de
// `account_members`, o script continua VERDE — porque `member_name` ainda tem
// grant e `has_any_column_privilege` responde "sim" pela tabela. Ou seja: dos
// dois bugs que motivaram este arquivo, ele teria pego UM.
//
// Pegar o outro exige cruzar com o CLIENTE: para cada `.update({a, b})` em
// src/scripts, conferir grant de coluna para `a` e para `b`. É a evolução
// natural daqui — não feita ainda, e por isso está escrito e não subentendido.
//
// USO
//   node scripts/check-policy-grant.mjs           (relata; sai 0)
//   node scripts/check-policy-grant.mjs --strict  (sai 1 se achar)
//
// Precisa de SUPABASE_ACCESS_TOKEN. Fora do CI por isso — o CI não tem o token,
// e um passo que falha por falta de credencial ensina a ignorar o CI.
// ─────────────────────────────────────────────────────────────────────────────

const REF = process.env.SUPABASE_PROJECT_REF ?? 'fvrhqqeofqedmhadzzqw';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
    console.error('Falta SUPABASE_ACCESS_TOKEN no ambiente.');
    process.exit(2);
}

async function sql(query) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
}

// `has_any_column_privilege` cobre o grant por coluna; `has_table_privilege`
// cobre o de tabela. Uma policy só é inalcançável quando os DOIS são falsos.
const CONSULTA = `
  WITH pol AS (
    SELECT tablename, policyname, cmd, unnest(roles)::text AS role
    FROM pg_policies WHERE schemaname = 'public'
  )
  SELECT tablename, policyname, cmd, role
  FROM pol
  WHERE role NOT IN ('service_role', 'postgres', 'supabase_admin')
    AND cmd <> 'ALL'
    -- "public" NÃO é um role: é "todo mundo". A policy é alcançável se
    -- QUALQUER role real conseguir exercer o comando. Testar só "anon" dava
    -- falso positivo numa policy que o "authenticated" exerce — pego ao mutar.
    AND NOT EXISTS (
      SELECT 1 FROM unnest(CASE WHEN role = 'public'
                                THEN ARRAY['anon','authenticated']
                                ELSE ARRAY[role] END) AS r(nome)
      WHERE has_table_privilege(r.nome, ('public.' || tablename)::regclass, cmd)
         OR has_any_column_privilege(r.nome, ('public.' || tablename)::regclass, cmd))
  ORDER BY tablename, policyname`;

const achados = await sql(CONSULTA);

if (achados.length === 0) {
    console.log('✓ policy×grant: nenhuma policy inalcançável');
} else {

console.log(`\n⚠️  ${achados.length} policy(s) que o role NÃO consegue exercer:\n`);
for (const a of achados) {
    console.log(`  ${a.tablename}.${a.policyname}  — ${a.cmd} para "${a.role}"`);
}
console.log(`
  Cada uma é UMA DE DUAS COISAS, e a diferença importa:

  (a) FUNCIONALIDADE QUEBRADA — o cliente chama e leva 403 calado.
      Procure por \`from('<tabela>')\` em src/scripts. Se achar, o conserto é
      GRANT (de preferência POR COLUNA), nunca DROP POLICY.

  (b) CRUFT DE VERDADE — nenhum chamador no cliente, acesso só por Edge com
      service_role. Aí sim DROP POLICY.

  Decidir sem procurar o chamador foi o que quase cimentou dois bugs em
  2026-08-09. Procure primeiro.
`);
}

// `process.exitCode` e NÃO `process.exit()`: sair no mesmo tick em que se
// escreveu no stdout aborta o Node no Windows com
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" e devolve 127 —
// um crash que se disfarça de reprovação. Pego ao mutar este próprio script.
process.exitCode = (process.argv.includes('--strict') && achados.length) ? 1 : 0;
