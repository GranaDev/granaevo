#!/usr/bin/env node
/**
 * purgar-fotos-orfas.mjs — expurgo LGPD art. 16 das fotos de titulares já excluídos.
 *
 * CONTEXTO (auditoria 2026-08-21)
 * `storage.objects` não tem FK para `auth.users`: o vínculo é o NOME do arquivo
 * (`${user_id}/${ts}.ext`). Existem 4 caminhos que apagam usuário e nenhum tocava o
 * bucket — os 3 crons são SQL puro e não conseguem chamar a Storage API. Resultado
 * medido: 35 de 44 objetos em 14 pastas de user_id inexistente, o mais antigo de
 * 2026-01-09.
 *
 * POR QUE NÃO DÁ PARA FAZER SÓ EM SQL
 * Apagar a linha de `storage.objects` deixa o arquivo no S3 — lixo pago e invisível,
 * sem sequer a linha para reencontrá-lo. A remoção tem de passar pela Storage API.
 *
 * USO
 *   # 1. dry-run (PADRÃO): não apaga nada, só mostra
 *   node scripts/purgar-fotos-orfas.mjs
 *
 *   # 2. depois de revisar a lista acima, apaga de verdade
 *   node scripts/purgar-fotos-orfas.mjs --confirmar
 *
 * CREDENCIAL
 * Exige a secret key do projeto numa variável de ambiente da SESSÃO:
 *   PowerShell:  $env:SUPABASE_SECRET_KEY = '<cole aqui>'
 *   bash:        export SUPABASE_SECRET_KEY='<cole aqui>'
 * NUNCA escreva a chave em arquivo, nem a cole num chat. Ela não está (e não deve
 * estar) em `.env.local` — mora só nos secrets do Supabase.
 */

const SUPABASE_URL = process.env.SUPABASE_URL
  ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null)
const SECRET = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

const BUCKET   = 'profile-photos'
const APLICAR  = process.argv.includes('--confirmar')
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Trava de sanidade: se o script quiser apagar mais pastas do que isto, algo está
// errado (chave errada, projeto errado, Admin API devolvendo lista vazia de usuários)
// e é melhor abortar do que destruir dado. Ver a checagem `usuarios.length === 0`.
const MAX_PASTAS_POR_EXECUCAO = 50

function morrer(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1) }

if (!SUPABASE_URL) morrer('Defina SUPABASE_URL ou SUPABASE_PROJECT_REF no ambiente.')
if (!SECRET) {
  morrer(
    'Falta a secret key. Defina na SESSÃO do shell (não em arquivo):\n' +
    "  PowerShell:  $env:SUPABASE_SECRET_KEY = '<chave>'\n" +
    "  bash:        export SUPABASE_SECRET_KEY='<chave>'"
  )
}

const h = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

async function api(caminho, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${caminho}`, { ...init, headers: { ...h, ...init.headers } })
  if (!r.ok) morrer(`${init.method ?? 'GET'} ${caminho} → HTTP ${r.status} ${await r.text()}`)
  return r.json()
}

/** Todos os user_id vivos, paginando a Admin API (o default é 50 por página). */
async function usuariosVivos() {
  const ids = new Set()
  for (let page = 1; page <= 200; page++) {
    const d = await api(`/auth/v1/admin/users?page=${page}&per_page=200`)
    const lote = d?.users ?? []
    for (const u of lote) ids.add(u.id)
    if (lote.length < 200) break
  }
  return ids
}

/** Pastas de 1º nível do bucket (cada uma é um user_id). */
async function pastasDoBucket() {
  const d = await api(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  })
  // A Storage API devolve pastas como itens com `id: null`.
  return d.filter((o) => o.id === null).map((o) => o.name)
}

async function arquivosDaPasta(pasta) {
  const d = await api(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    body: JSON.stringify({ prefix: `${pasta}/`, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  })
  return d.filter((o) => o.id !== null)
}

const kb = (n) => `${(Number(n ?? 0) / 1024).toFixed(1)} KB`

async function main() {
  console.log(`\n🔎 Bucket: ${BUCKET}   Projeto: ${SUPABASE_URL}`)
  console.log(APLICAR ? '⚠️  MODO: APAGAR DE VERDADE (--confirmar)\n' : '🧪 MODO: DRY-RUN (nada será apagado)\n')

  const vivos = await usuariosVivos()
  // Guarda contra o pior modo de falha possível: se a Admin API devolvesse vazio por
  // erro de permissão, TODA pasta pareceria órfã e o script apagaria o bucket inteiro.
  if (vivos.size === 0) morrer('A Admin API devolveu ZERO usuários. Isso é erro de credencial, não um banco vazio. Abortando.')
  console.log(`   usuários vivos: ${vivos.size}`)

  const pastas = await pastasDoBucket()
  console.log(`   pastas no bucket: ${pastas.length}`)

  const orfas = pastas.filter((p) => UUID_RE.test(p) && !vivos.has(p))
  const ignoradas = pastas.filter((p) => !UUID_RE.test(p))
  if (ignoradas.length) {
    // Melhor deixar lixo do que apagar objeto cujo dono não sabemos determinar.
    console.log(`   ⏭️  ignoradas (nome não é UUID): ${ignoradas.join(', ')}`)
  }

  if (orfas.length === 0) { console.log('\n✅ Nenhuma pasta órfã. Nada a fazer.\n'); return }
  if (orfas.length > MAX_PASTAS_POR_EXECUCAO) {
    morrer(`${orfas.length} pastas órfãs — acima da trava de ${MAX_PASTAS_POR_EXECUCAO}. Confira a credencial e o projeto antes de prosseguir.`)
  }

  let totalArquivos = 0, totalBytes = 0
  const plano = []
  for (const pasta of orfas) {
    const arqs = await arquivosDaPasta(pasta)
    const bytes = arqs.reduce((s, a) => s + Number(a.metadata?.size ?? 0), 0)
    totalArquivos += arqs.length; totalBytes += bytes
    plano.push({ pasta, caminhos: arqs.map((a) => `${pasta}/${a.name}`), n: arqs.length, bytes,
                 maisAntigo: arqs.map((a) => a.created_at).sort()[0] })
  }

  console.log(`\n📋 ${orfas.length} pasta(s) órfã(s) · ${totalArquivos} arquivo(s) · ${kb(totalBytes)}\n`)
  for (const p of plano) {
    console.log(`   ${p.pasta}  ${String(p.n).padStart(2)} arq  ${kb(p.bytes).padStart(9)}  desde ${(p.maisAntigo ?? '?').slice(0, 10)}`)
  }

  if (!APLICAR) {
    console.log('\n🧪 DRY-RUN — nada foi apagado.')
    console.log('   Revise a lista acima. Se estiver correta, rode de novo com --confirmar\n')
    return
  }

  console.log('\n🗑️  Apagando…\n')
  let ok = 0, falhas = 0
  for (const p of plano) {
    // Reconfere na hora: entre a listagem e o DELETE alguém pode ter recriado a conta.
    if (vivos.has(p.pasta)) { console.log(`   ⏭️  ${p.pasta} — virou usuário vivo, pulando`); continue }
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: p.caminhos }),
    })
    if (r.ok) { ok += p.n; console.log(`   ✅ ${p.pasta} — ${p.n} arquivo(s)`) }
    else      { falhas += p.n; console.log(`   ❌ ${p.pasta} — HTTP ${r.status} ${await r.text()}`) }
  }

  console.log(`\n📊 Removidos: ${ok}   Falhas: ${falhas}`)
  console.log('   Reconfira com a query do relatório (deve dar arquivos_orfaos = 0).\n')
}

main().catch((e) => morrer(e?.message ?? String(e)))
