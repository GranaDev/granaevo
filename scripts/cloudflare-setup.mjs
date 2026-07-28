#!/usr/bin/env node
/**
 * GranaEvo — Configuração completa do Cloudflare (plano FREE)  [B-2 · B-3]
 * ---------------------------------------------------------------------------
 * Aplica TODAS as proteções que o plano gratuito oferece, de forma idempotente:
 * rodar duas vezes dá o mesmo resultado.
 *
 * PRÉ-REQUISITOS (só você pode fazer — ver docs/cloudflare-runbook.md):
 *   1. Site adicionado ao Cloudflare e nameservers trocados no Hostinger.
 *      Hoje o domínio aponta para ns1/ns2.dns-parking.com e NENHUM host tem
 *      cf-ray — ou seja, o Cloudflare não está no caminho.
 *   2. Token de API com escopo de Zona (Edit) nas variáveis de ambiente:
 *        setx CLOUDFLARE_API_TOKEN "..."      (Windows, reabrir o terminal)
 *      O token NUNCA entra em arquivo versionado nem no chat — mesma regra do
 *      SUPABASE_ACCESS_TOKEN.
 *
 * USO:
 *   node scripts/cloudflare-setup.mjs --dry-run    ← mostra o que faria
 *   node scripts/cloudflare-setup.mjs              ← aplica
 *
 * ⚠️ CACHE: a maior dor de cabeça de pôr um app dinâmico atrás do Cloudflare é
 * ele cachear o que não devia. As regras abaixo colocam /api/* em BYPASS
 * explícito e mandam respeitar o Cache-Control que a Vercel já manda (o
 * vercel.json define no-store nas rotas autenticadas e immutable nos assets).
 * Sem isso, uma resposta de /api/user-data de um usuário pode ser servida a
 * outro — o pior bug possível neste app.
 */

const TOKEN  = process.env.CLOUDFLARE_API_TOKEN
const DOMAIN = process.env.CLOUDFLARE_DOMAIN ?? 'granaevo.com'
const DRY    = process.argv.includes('--dry-run')
const API    = 'https://api.cloudflare.com/client/v4'

if (!TOKEN) {
  console.error('\n❌ CLOUDFLARE_API_TOKEN ausente.\n')
  console.error('   Crie em: https://dash.cloudflare.com/profile/api-tokens')
  console.error('   Permissões mínimas: Zone → Zone Settings:Edit, Zone:Edit,')
  console.error('                       Zone → Firewall Services:Edit, Zone WAF:Edit,')
  console.error('                       Account → Turnstile:Edit')
  console.error('   Depois:  setx CLOUDFLARE_API_TOKEN "seu-token"  e reabra o terminal.\n')
  process.exit(1)
}

let ok = 0, falhas = 0, pulados = 0

async function cf(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.success !== false, status: r.status, data: j.result, errors: j.errors }
}

/** Aplica um setting de zona. Muitos não existem no free — isso é esperado. */
async function setting(zone, nome, valor, porque) {
  if (DRY) { console.log(`  [dry] ${nome} = ${JSON.stringify(valor)}  — ${porque}`); return }
  const r = await cf(`/zones/${zone}/settings/${nome}`, { method: 'PATCH', body: { value: valor } })
  if (r.ok) { console.log(`  ✅ ${nome} = ${JSON.stringify(valor)}`); ok++ }
  else {
    const msg = r.errors?.[0]?.message ?? `HTTP ${r.status}`
    // Setting indisponível no plano é informação, não erro de execução.
    if (/not available|upgrade|plan/i.test(msg)) { console.log(`  ⏭️  ${nome} — indisponível no free (${msg})`); pulados++ }
    else { console.log(`  ❌ ${nome} — ${msg}`); falhas++ }
  }
}

// ── Registros que PRECISAM sobreviver à migração ────────────────────────────
// Fotografados do DNS ativo em 2026-07-27, ANTES de qualquer mudança. O script
// confere um por um contra o que o Cloudflare importou.
//
// Os três de e-mail são o item mais crítico da migração inteira: se um MX ou o
// SPF se perder, `privacidade@granaevo.com` para de receber — e esse é o canal
// do titular na LGPD, declarado na Política de Privacidade.
const ESPERADOS = [
  { tipo: 'A',     nome: 'granaevo.com',                    contem: '76.76.21.21',        papel: 'apex → Vercel',            proxy: true  },
  { tipo: 'CNAME', nome: 'www.granaevo.com',                contem: 'vercel-dns',         papel: 'www → Vercel',             proxy: true  },
  { tipo: 'CNAME', nome: 'assistente.granaevo.com',         contem: 'vercel-dns',         papel: 'PWA do assistente',        proxy: true  },
  { tipo: 'MX',    nome: 'granaevo.com',                    contem: 'mx1.improvmx.com',   papel: '📧 recebe e-mail (prio 10)', proxy: false },
  { tipo: 'MX',    nome: 'granaevo.com',                    contem: 'mx2.improvmx.com',   papel: '📧 recebe e-mail (prio 20)', proxy: false },
  { tipo: 'TXT',   nome: 'granaevo.com',                    contem: 'spf.improvmx.com',   papel: '📧 SPF',                    proxy: false },
  { tipo: 'TXT',   nome: 'resend._domainkey.granaevo.com',  contem: 'p=MIGfMA0',          papel: '📧 DKIM do Resend',         proxy: false },
  { tipo: 'TXT',   nome: '_dmarc.granaevo.com',             contem: 'v=DMARC1',           papel: '📧 DMARC',                  proxy: false },
  { tipo: 'TXT',   nome: 'send.granaevo.com',               contem: 'amazonses.com',      papel: '📧 SPF do envio (Resend)',  proxy: false },
]

/** Confere se o Cloudflare importou tudo. Só lê — não muda nada. */
async function auditarDns(Z) {
  console.log('\n📋 Conferindo os registros importados\n')
  const r = await cf(`/zones/${Z}/dns_records?per_page=200`)
  if (!r.ok) { console.error('  ❌ não consegui listar os registros'); return false }
  const atuais = r.data ?? []

  let faltando = 0
  for (const e of ESPERADOS) {
    const achou = atuais.find(a =>
      a.type === e.tipo &&
      a.name === e.nome &&
      String(a.content ?? '').includes(e.contem))
    if (achou) {
      const nuvem = achou.proxied ? '🟠 proxy' : '⚪ dns-only'
      console.log(`  ✅ ${e.tipo.padEnd(5)} ${e.papel.padEnd(32)} ${nuvem}`)
    } else {
      console.log(`  ❌ ${e.tipo.padEnd(5)} ${e.papel.padEnd(32)} FALTANDO — esperado conter "${e.contem}"`)
      faltando++
    }
  }

  const extras = atuais.filter(a => !ESPERADOS.some(e => e.tipo === a.tipo && e.nome === a.nome))
  if (extras.length) {
    console.log('\n  ℹ️  Registros a mais (podem ser legítimos — confira):')
    for (const x of extras) console.log(`      ${x.type} ${x.name} → ${String(x.content).slice(0, 50)}`)
  }

  if (faltando) {
    console.error(`\n  🛑 ${faltando} registro(s) faltando. NÃO troque os nameservers ainda —`)
    console.error('     adicione o que falta no painel do Cloudflare primeiro.')
    return false
  }
  console.log('\n  ✅ Todos os 9 registros presentes.')
  return true
}

/**
 * Liga/desliga o proxy (nuvem laranja) só nos hosts do SITE.
 * Registro de e-mail NUNCA é tocado — MX não se proxia, e mexer no SPF/DKIM
 * quebraria a entrega.
 */
async function proxy(Z, ligar) {
  console.log(`\n🔶 ${ligar ? 'Ligando' : 'Desligando'} o proxy nos hosts do site\n`)
  const r = await cf(`/zones/${Z}/dns_records?per_page=200`)
  const atuais = r.data ?? []
  for (const e of ESPERADOS.filter(x => x.proxy)) {
    const rec = atuais.find(a => a.type === e.tipo && a.name === e.nome)
    if (!rec) { console.log(`  ⏭️  ${e.papel} — registro não encontrado`); continue }
    if (rec.proxied === ligar) { console.log(`  ✅ ${e.papel} — já estava ${ligar ? 'proxiado' : 'dns-only'}`); ok++; continue }
    if (DRY) { console.log(`  [dry] ${e.papel} → ${ligar ? 'proxy' : 'dns-only'}`); continue }
    const up = await cf(`/zones/${Z}/dns_records/${rec.id}`, {
      method: 'PATCH', body: { proxied: ligar },
    })
    if (up.ok) { console.log(`  ✅ ${e.papel} → ${ligar ? '🟠 proxy' : '⚪ dns-only'}`); ok++ }
    else { console.log(`  ❌ ${e.papel} — ${up.errors?.[0]?.message ?? up.status}`); falhas++ }
  }
}

async function main() {
  console.log(`\n🛡️  Cloudflare — ${DOMAIN}${DRY ? '  (DRY RUN)' : ''}\n`)

  const z = await cf(`/zones?name=${DOMAIN}`)
  const zona = z.data?.[0]
  if (!zona) {
    console.error(`❌ Zona "${DOMAIN}" não encontrada nesta conta.`)
    console.error('   O site precisa estar adicionado ao Cloudflare E com os nameservers')
    console.error('   apontando para lá. Ver docs/cloudflare-runbook.md, passo 1.')
    process.exit(1)
  }
  console.log(`Zona: ${zona.id}  ·  status: ${zona.status}  ·  plano: ${zona.plan?.name}\n`)
  if (zona.status !== 'active') {
    console.warn('⚠️  Zona ainda não está "active" — os nameservers não propagaram.')
    console.warn('    Pode aplicar mesmo assim; as regras passam a valer quando ativar.\n')
  }
  const Z = zona.id

  // Modos dedicados: auditoria e controle de proxy saem antes de tudo.
  if (process.argv.includes('--audit-dns')) { process.exit(await auditarDns(Z) ? 0 : 1) }
  if (process.argv.includes('--proxy=on'))  { await proxy(Z, true);  process.exit(falhas ? 1 : 0) }
  if (process.argv.includes('--proxy=off')) { await proxy(Z, false); process.exit(falhas ? 1 : 0) }

  // O setup completo começa conferindo o DNS: aplicar regras numa zona com
  // registro de e-mail faltando seria consolidar a quebra.
  if (!await auditarDns(Z)) process.exit(1)

  // ── 1. TLS ────────────────────────────────────────────────────────────────
  console.log('1) TLS e transporte')
  // "strict" exige certificado válido na origem — a Vercel tem. "full" sem
  // strict aceitaria certificado forjado entre Cloudflare e origem.
  await setting(Z, 'ssl', 'strict', 'valida o certificado da origem (Vercel)')
  await setting(Z, 'always_use_https', 'on', 'redireciona http→https na borda')
  await setting(Z, 'min_tls_version', '1.2', 'corta TLS 1.0/1.1')
  await setting(Z, 'tls_1_3', 'on', 'handshake mais rápido e seguro')
  await setting(Z, 'automatic_https_rewrites', 'on', 'reescreve sub-recursos http→https')
  await setting(Z, 'opportunistic_encryption', 'on', '')
  // HSTS: o vercel.json já manda o header, mas na borda ele vale mesmo se a
  // origem cair. 2 anos + subdomínios + preload, igual ao que já está no app.
  await setting(Z, 'security_header', {
    strict_transport_security: {
      enabled: true, max_age: 63072000, include_subdomains: true, preload: true, nosniff: true,
    },
  }, 'HSTS na borda, alinhado ao vercel.json')

  // ── 2. Segurança / bots ───────────────────────────────────────────────────
  console.log('\n2) Segurança e bots')
  await setting(Z, 'security_level', 'medium', 'desafia IPs com reputação ruim')
  await setting(Z, 'browser_check', 'on', 'bloqueia user-agents e headers forjados grosseiros')
  await setting(Z, 'challenge_ttl', 1800, 'quanto tempo um desafio resolvido vale')
  await setting(Z, 'privacy_pass', 'on', 'menos captcha para quem usa Privacy Pass')

  // Bot Fight Mode é o anti-bot do free. Fica em endpoint próprio.
  if (!DRY) {
    const r = await cf(`/zones/${Z}/bot_management`, { method: 'PUT', body: { fight_mode: true } })
    if (r.ok) { console.log('  ✅ bot_fight_mode = on'); ok++ }
    else { console.log(`  ⏭️  bot_fight_mode — ${r.errors?.[0]?.message ?? 'indisponível'}`); pulados++ }
  } else console.log('  [dry] bot_fight_mode = on')

  // ── 3. Scrape Shield ──────────────────────────────────────────────────────
  console.log('\n3) Scrape Shield')
  await setting(Z, 'email_obfuscation', 'on', 'esconde e-mails de scrapers no HTML')
  await setting(Z, 'hotlink_protection', 'on', 'impede uso das imagens por terceiros')
  await setting(Z, 'server_side_exclude', 'on', '')

  // ── 4. Rede ───────────────────────────────────────────────────────────────
  console.log('\n4) Rede')
  await setting(Z, 'websockets', 'on', 'o Realtime do Supabase usa wss')
  await setting(Z, 'ip_geolocation', 'on', 'header CF-IPCountry para as regras')
  await setting(Z, 'brotli', 'on', 'compressão melhor que gzip')
  await setting(Z, 'early_hints', 'on', '')
  await setting(Z, '0rtt', 'off', 'OFF de propósito: 0-RTT permite replay de requisição')

  // ── 5. Cache — a parte que mais dá dor de cabeça ───────────────────────────
  console.log('\n5) Cache')
  await setting(Z, 'cache_level', 'standard', '')
  await setting(Z, 'browser_cache_ttl', 0, 'respeita o Cache-Control que a Vercel manda')
  await setting(Z, 'always_online', 'off', 'OFF: servir página velha de app financeiro engana o usuário')

  // ── 6. Regras de WAF (custom rules) ───────────────────────────────────────
  // O free permite 5 regras customizadas. Estas são as 5 que valem a pena aqui.
  console.log('\n6) Regras de firewall (5 no free)')
  const regras = [
    {
      description: 'BYPASS de cache e proteção para /api/* (NUNCA cachear)',
      expression: '(starts_with(http.request.uri.path, "/api/"))',
      action: 'skip',
      action_parameters: { ruleset: 'current', phases: ['http_request_cache_settings'] },
      _nota: 'Sem isto, uma resposta de /api/user-data de um usuário pode ser servida a outro.',
    },
    {
      description: 'Desafia acesso automatizado ao login e cadastro',
      expression: '(http.request.uri.path in {"/login" "/api/auth-session" "/api/create-account"} and cf.threat_score gt 14)',
      action: 'managed_challenge',
      _nota: 'Complementa o lockout por conta (S-2) e o limite por IP na aplicação.',
    },
    {
      description: 'Bloqueia varredura de caminhos que não existem aqui',
      expression: '(http.request.uri.path contains "/wp-" or http.request.uri.path contains "/.env" or http.request.uri.path contains "/.git" or http.request.uri.path contains "/phpmyadmin" or http.request.uri.path contains "/xmlrpc")',
      action: 'block',
      _nota: 'Ruído constante de botnet; barrar na borda tira carga da Vercel.',
    },
    {
      description: 'Bloqueia métodos HTTP que o app não usa',
      expression: '(not http.request.method in {"GET" "POST" "OPTIONS" "HEAD"})',
      action: 'block',
      _nota: 'O app só usa estes quatro. PUT/DELETE/TRACE na borda é sempre sondagem.',
    },
    {
      description: 'Desafia requisição sem user-agent',
      expression: '(http.user_agent eq "" and not starts_with(http.request.uri.path, "/api/"))',
      action: 'managed_challenge',
      _nota: '/api/* fica de fora: o cron da Vercel e os webhooks legítimos podem não mandar UA.',
    },
  ]

  if (DRY) {
    for (const r of regras) console.log(`  [dry] ${r.action.padEnd(18)} ${r.description}\n         ${r._nota}`)
  } else {
    const rs = await cf(`/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint`)
    const id = rs.data?.id
    const payload = { rules: regras.map(({ _nota, ...r }) => r) }
    const res = id
      ? await cf(`/zones/${Z}/rulesets/${id}`, { method: 'PUT', body: payload })
      : await cf(`/zones/${Z}/rulesets`, { method: 'POST',
          body: { name: 'GranaEvo custom', kind: 'zone', phase: 'http_request_firewall_custom', ...payload } })
    if (res.ok) { console.log(`  ✅ ${regras.length} regras aplicadas`); ok++ }
    else { console.log(`  ❌ regras — ${res.errors?.[0]?.message ?? res.status}`); falhas++ }
  }

  // ── 7. Rate limiting na borda (B-3) ───────────────────────────────────────
  // O free dá 1 regra. Ela vai no endpoint mais atacável: o login.
  // Diferença para o limite da aplicação: este barra ANTES de executar a
  // função na Vercel — um flood não chega a custar invocação.
  console.log('\n7) Rate limiting na borda (1 regra no free) — B-3')
  const rl = {
    description: 'Login: 10 req / 10s por IP',
    expression: '(http.request.uri.path eq "/api/auth-session")',
    action: 'block',
    ratelimit: {
      characteristics: ['ip.src', 'cf.colo.id'],
      period: 10, requests_per_period: 10, mitigation_timeout: 60,
    },
  }
  if (DRY) console.log(`  [dry] ${rl.description}`)
  else {
    const rs = await cf(`/zones/${Z}/rulesets/phases/http_ratelimit/entrypoint`)
    const id = rs.data?.id
    const res = id
      ? await cf(`/zones/${Z}/rulesets/${id}`, { method: 'PUT', body: { rules: [rl] } })
      : await cf(`/zones/${Z}/rulesets`, { method: 'POST',
          body: { name: 'GranaEvo ratelimit', kind: 'zone', phase: 'http_ratelimit', rules: [rl] } })
    if (res.ok) { console.log('  ✅ rate limit aplicado'); ok++ }
    else { console.log(`  ⏭️  rate limit — ${res.errors?.[0]?.message ?? res.status}`); pulados++ }
  }

  // ── 8. WAF gerenciado ─────────────────────────────────────────────────────
  console.log('\n8) WAF gerenciado (Cloudflare Free Managed Ruleset)')
  console.log('   Ativado automaticamente no free. Confira em Security → WAF →')
  console.log('   Managed rules que "Cloudflare Free Managed Ruleset" está Enabled.')

  // ── 9. DNSSEC ─────────────────────────────────────────────────────────────
  console.log('\n9) DNSSEC')
  if (DRY) console.log('  [dry] habilitar DNSSEC')
  else {
    const r = await cf(`/zones/${Z}/dnssec`, { method: 'PATCH', body: { status: 'active' } })
    if (r.ok) {
      console.log('  ✅ DNSSEC habilitado no Cloudflare')
      console.log('  ⚠️  FALTA VOCÊ: copiar o registro DS para o Hostinger (registrar).')
      console.log('      Sem esse passo o DNSSEC não vale nada.')
      if (r.data?.ds) console.log(`      DS: ${r.data.ds}`)
      ok++
    } else { console.log(`  ⏭️  DNSSEC — ${r.errors?.[0]?.message ?? r.status}`); pulados++ }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`aplicados: ${ok}   pulados (indisponíveis no free): ${pulados}   falhas: ${falhas}`)
  console.log('\nPRÓXIMO PASSO MANUAL: Turnstile (B-2) — ver docs/cloudflare-runbook.md §4.')
  console.log(`${'─'.repeat(60)}\n`)
  process.exit(falhas > 0 ? 1 : 0)
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1) })
