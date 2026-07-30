#!/usr/bin/env node
/**
 * GranaEvo — Remove a conta descartável dos testes manuais do Bloco 2
 * ---------------------------------------------------------------------------
 * Criada em 2026-07-30 para exercitar 2FA e exportação LGPD com um humano de
 * verdade, sem tocar na conta principal. Ver docs/testes-manuais-pendentes.md.
 *
 * USO:
 *   node scripts/remove-conta-teste.mjs --dry-run   ← mostra o que apagaria
 *   node scripts/remove-conta-teste.mjs             ← apaga
 *
 * PRÉ-REQUISITO: SUPABASE_ACCESS_TOKEN (PAT) no ambiente. Nunca no chat, nunca
 * versionado — mesma regra do CLOUDFLARE_API_TOKEN.
 *
 * ⚠️ POR QUE ESTE SCRIPT EXISTE, em vez de um DELETE solto:
 * a trava é o e-mail literal abaixo. Um DELETE colado à mão num terminal, num
 * banco de produção, com um WHERE errado, apaga usuários reais. Aqui o alvo é
 * constante, o script conta as linhas antes, e recusa se achar mais de uma
 * conta. Também confere que a assinatura é a FALSA (`*_FAKE_TESTE_DESCARTAVEL`)
 * antes de apagar: se um dia esse e-mail virar cliente pagante, o script para.
 */

const ALVO  = 'oliveiralucas00224+teste2fa@gmail.com'
const REF   = process.env.SUPABASE_PROJECT_REF ?? 'fvrhqqeofqedmhadzzqw'
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const DRY   = process.argv.includes('--dry-run')

if (!TOKEN) {
  console.error('\n❌ SUPABASE_ACCESS_TOKEN ausente.')
  console.error('   Crie em: https://supabase.com/dashboard/account/tokens')
  console.error('   Depois:  setx SUPABASE_ACCESS_TOKEN "seu-pat"  e reabra o terminal.\n')
  process.exit(1)
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`)
  return JSON.parse(texto)
}

const lit = ALVO.replace(/'/g, "''")   // o alvo é constante, mas escapar é grátis

;(async () => {
  // 1. Censo antes de tocar em nada.
  const censo = await sql(`
    SELECT u.id::text                                    AS user_id,
           u.created_at,
           (SELECT count(*) FROM auth.identities i
              WHERE i.user_id = u.id)                    AS identities,
           (SELECT count(*) FROM auth.mfa_factors f
              WHERE f.user_id = u.id)                    AS fatores_mfa,
           (SELECT count(*) FROM public.profiles p
              WHERE p.user_id = u.id)                    AS perfis,
           (SELECT string_agg(s.stripe_customer_id, ',')
              FROM public.stripe_subscriptions s
              WHERE s.user_id = u.id)                    AS customers
    FROM auth.users u
    WHERE u.email = '${lit}'
  `)

  if (censo.length === 0) {
    console.log(`\n✅ Nada a fazer — ${ALVO} não existe mais.\n`)
    return
  }
  if (censo.length > 1) {
    console.error(`\n❌ ${censo.length} contas com esse e-mail. Abortando por segurança.\n`)
    process.exit(1)
  }

  const c = censo[0]

  // 2. Trava: só apaga se a assinatura for a falsa que EU criei.
  if (c.customers && !c.customers.includes('FAKE_TESTE_DESCARTAVEL')) {
    console.error('\n❌ Esta conta tem assinatura Stripe REAL:', c.customers)
    console.error('   Não é a conta de teste. Abortando.\n')
    process.exit(1)
  }

  console.log(`\nAlvo: ${ALVO}`)
  console.log(`  user_id ....... ${c.user_id}`)
  console.log(`  criada em ..... ${c.created_at}`)
  console.log(`  identities .... ${c.identities}`)
  console.log(`  fatores MFA ... ${c.fatores_mfa}`)
  console.log(`  perfis ........ ${c.perfis}`)
  console.log(`  stripe ........ ${c.customers ?? '(nenhuma)'}`)

  if (DRY) {
    console.log('\n--dry-run: nada foi apagado.\n')
    return
  }

  // 3. Apaga. O DELETE em auth.users leva o resto por FK ON DELETE CASCADE
  //    (identities, sessions, mfa_factors, refresh_tokens). O que está em
  //    public.* sem cascade vai explícito, e antes — se sobrar órfão, sobra
  //    referência a um user_id que não existe mais.
  const apagado = await sql(`
    WITH alvo AS (
      SELECT id FROM auth.users WHERE email = '${lit}'
    ),
    d_sub AS (
      DELETE FROM public.stripe_subscriptions
      WHERE user_id IN (SELECT id FROM alvo) RETURNING 1
    ),
    d_prof AS (
      DELETE FROM public.profiles
      WHERE user_id IN (SELECT id FROM alvo) RETURNING 1
    ),
    d_user AS (
      DELETE FROM auth.users
      WHERE id IN (SELECT id FROM alvo) RETURNING 1
    )
    SELECT (SELECT count(*) FROM d_sub)  AS assinaturas,
           (SELECT count(*) FROM d_prof) AS perfis,
           (SELECT count(*) FROM d_user) AS usuarios
  `)

  // 4. Confirma pelo banco, não pelo retorno do DELETE.
  const resto = await sql(`SELECT count(*) AS n FROM auth.users WHERE email = '${lit}'`)

  console.log('\nApagado:', JSON.stringify(apagado[0]))
  console.log(Number(resto[0].n) === 0
    ? '✅ Conta removida e confirmada ausente no banco.\n'
    : `❌ Ainda restam ${resto[0].n} linha(s) — verifique manualmente.\n`)
  if (Number(resto[0].n) !== 0) process.exit(1)
})().catch((e) => {
  console.error('\n❌ Falhou:', e.message, '\n')
  process.exit(1)
})
