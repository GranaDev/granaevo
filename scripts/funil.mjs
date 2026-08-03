#!/usr/bin/env node
// scripts/funil.mjs — M-7: medir signup → ativação → pagamento SEM rastreador.
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE NÃO É UM PIXEL
//   O M-7 pedia "pixel/analytics de funil". O código de evento até já existia
//   (`planos.js` dispara `gtag`/`fbq`), faltando só carregar as tags. Não
//   carreguei, e a razão não é técnica:
//
//   `privacidade.html` afirma, com estas palavras: **"o GranaEvo não utiliza
//   cookies de rastreamento"**. E a landing vende "Privacidade de Verdade —
//   diferente de outros apps". Subir GA4 e Meta Pixel tornaria essa frase
//   falsa, obrigaria a declarar Google e Meta como operadores + transferência
//   internacional, e — pela LGPD — exigiria CONSENTIMENTO explícito, porque
//   cookie de marketing não se sustenta em legítimo interesse.
//
//   Num produto que se vende por privacidade, o custo não é o banner: é a
//   contradição. Já é o que separa o GranaEvo dos concorrentes.
//
//   E era desnecessário: o funil que se queria medir (cadastrou → ativou →
//   pagou) está INTEIRO no nosso banco. `auth.users`, `profiles`,
//   `stripe_subscriptions` e `financial_audit_log` respondem tudo. Terceiro
//   nenhum precisa ver o usuário para a gente saber a taxa de conversão.
//
// O QUE ISTO NÃO MEDE (e é honesto dizer)
//   Origem do tráfego e comportamento ANTES do cadastro — visitante que chegou
//   e foi embora. Para isso, um dia, o caminho digno é analytics sem cookie
//   (Plausible/Umami, self-hosted), não pixel de rede social.
//
// USO:  node scripts/funil.mjs
// PRÉ-REQUISITO: SUPABASE_ACCESS_TOKEN no ambiente (nunca no chat, nunca no git)
// ─────────────────────────────────────────────────────────────────────────────

const REF   = process.env.SUPABASE_PROJECT_REF ?? 'fvrhqqeofqedmhadzzqw';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error('\n❌ SUPABASE_ACCESS_TOKEN ausente.');
  console.error('   Crie em https://supabase.com/dashboard/account/tokens e use');
  console.error('   `setx SUPABASE_ACCESS_TOKEN "..."` (reabra o terminal).\n');
  process.exit(1);
}

// Contas de teste não são clientes; contá-las infla a conversão e a gente
// acaba acreditando na própria maquiagem.
const SQL = `
WITH base AS (
  SELECT u.id, u.created_at, u.email,
         (SELECT count(*) FROM public.profiles p WHERE p.user_id = u.id)            AS perfis,
         (SELECT count(*) FROM public.stripe_subscriptions s
            WHERE s.user_id = u.id AND s.status IN ('active','trialing')
              AND s.stripe_customer_id NOT LIKE '%FAKE%')                           AS assina,
         (SELECT count(*) FROM public.financial_audit_log f WHERE f.user_id = u.id) AS atividade
  FROM auth.users u
  WHERE u.email NOT LIKE '%+teste%' AND u.email NOT LIKE '%+test%'
)
SELECT
  count(*)                                    AS cadastraram,
  count(*) FILTER (WHERE perfis    > 0)       AS criaram_perfil,
  count(*) FILTER (WHERE atividade > 0)       AS usaram,
  count(*) FILTER (WHERE assina    > 0)       AS pagantes,
  count(*) FILTER (WHERE created_at > now() - interval '30 days') AS novos_30d
FROM base;
`;

const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method:  'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body:    JSON.stringify({ query: SQL }),
});

if (!r.ok) {
  console.error('\n❌ Consulta falhou:', r.status, (await r.text()).slice(0, 200), '\n');
  process.exit(1);
}

const [f] = await r.json();
const pct = (n, de) => (de > 0 ? ((n / de) * 100).toFixed(1) + '%' : '—');
const barra = (n, de) => '█'.repeat(Math.round((de > 0 ? n / de : 0) * 28)).padEnd(28, '·');

const etapas = [
  ['Cadastraram',    f.cadastraram],
  ['Criaram perfil', f.criaram_perfil],
  ['Usaram de fato', f.usaram],
  ['Pagantes',       f.pagantes],
];

console.log('\n  FUNIL — GranaEvo   (sem rastreador: 100% dados próprios)\n');
for (const [nome, n] of etapas) {
  console.log(`  ${nome.padEnd(16)} ${barra(n, f.cadastraram)} ${String(n).padStart(4)}  ${pct(n, f.cadastraram)}`);
}

console.log(`\n  Conversão cadastro → pagante: ${pct(f.pagantes, f.cadastraram)}`);
console.log(`  Cadastros nos últimos 30 dias: ${f.novos_30d}`);

// A maior queda entre etapas é onde vale trabalhar — e não adianta otimizar a
// landing se quem entra não chega a criar um perfil.
let pior = null;
for (let i = 1; i < etapas.length; i++) {
  const perda = etapas[i - 1][1] - etapas[i][1];
  if (!pior || perda > pior.perda) pior = { de: etapas[i - 1][0], para: etapas[i][0], perda };
}
if (pior && pior.perda > 0) {
  console.log(`\n  Maior perda: ${pior.de} → ${pior.para} (${pior.perda} pessoa(s))`);
}
console.log('');
