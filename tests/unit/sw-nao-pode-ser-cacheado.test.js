/**
 * O SERVICE WORKER NÃO PODE SER CACHEADO NA CDN.
 *
 * ACHADO (2026-08-15). Medido em produção:
 *
 *   GET /sw.js
 *   Cache-Control: public, max-age=3600, stale-while-revalidate=86400
 *   Age: 1266 · cf-cache-status: HIT
 *
 * E o conteúdo servido era o do deploy ANTERIOR — o mesmo arquivo, pedido com
 * `?cb=<timestamp>`, voltava correto. O arquivo certo estava no servidor; a CDN
 * é que entregava o velho por até 1 hora (24 h contando o stale-while-revalidate).
 *
 * POR QUE ISSO QUEBRA O APP, e não é só "cache desatualizado":
 * o `sw.js` do Workbox CARREGA DENTRO DELE o manifesto de precache — a lista
 * exata dos assets com hash daquele build. Servir um `sw.js` velho faz o
 * navegador precachear os arquivos do deploy anterior, enquanto o HTML (que é
 * `no-store`, sempre fresco) manda a página pedir os do deploy novo.
 *
 *   HTML novo pede   db-transacoes-CdxOpG4s.js
 *   SW velho cacheou db-transacoes-DnAj4rnC.js
 *
 * Offline, todo chunk lazy que a página pedir simplesmente não existe no cache.
 * Foi exatamente o sintoma relatado: "no dashboard, fico offline, vou para
 * Transações e o seletor de tipo não abre nem lança".
 *
 * O detalhe que fecha o diagnóstico: `vercel.json` JÁ TINHA a regra certa para
 * `/assistant-sw.js`. Alguém conheceu a armadilha, resolveu para um Service
 * Worker, e o principal ficou de fora — a mesma forma de todos os achados deste
 * dia (o controle existe; o caminho principal não passa por ele).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERCEL = JSON.parse(readFileSync(join(RAIZ, 'vercel.json'), 'utf8'))

/** A regra de header que a Vercel aplicaria a este caminho (a ÚLTIMA que casa). */
function regraPara(caminho) {
  let achada = null
  for (const regra of VERCEL.headers ?? []) {
    let re
    try { re = new RegExp('^' + regra.source + '$') } catch { continue }
    if (re.test(caminho)) achada = regra
  }
  return achada
}

const valorDe = (regra, chave) =>
  regra?.headers?.find((h) => h.key.toLowerCase() === chave.toLowerCase())?.value ?? ''

/** Um arquivo é "sem hash" quando o nome não carrega o fingerprint do build. */
const semHash = (nome) => !/-[A-Za-z0-9_-]{8}\.js$/.test(nome)

// ─────────────────────────────────────────────────────────────────────────────
describe('⭐ o sw.js não pode ser servido de cache', () => {
  test('existe regra explícita cobrindo /sw.js', () => {
    const r = regraPara('/sw.js')
    assert.ok(r, 'nenhuma regra de header cobre /sw.js — ele cai no default da CDN (1 h)')
  })

  test('⭐ o cache do navegador é revalidado sempre', () => {
    const cc = valorDe(regraPara('/sw.js'), 'Cache-Control')
    assert.match(cc, /max-age=0/, `Cache-Control do sw.js é "${cc}" — qualquer max-age > 0 serve manifesto velho`)
    assert.match(cc, /must-revalidate/)
    assert.doesNotMatch(cc, /stale-while-revalidate/,
      'stale-while-revalidate no sw.js entrega o manifesto antigo por horas depois de expirar')
  })

  test('⭐ e o cache da CDN também — nos dois provedores', () => {
    // `Cache-Control` sozinho não bastou: o Cloudflare respondeu HIT com Age
    // 1266. Vercel lê `CDN-Cache-Control`; Cloudflare lê o header próprio dele.
    const r = regraPara('/sw.js')
    assert.match(valorDe(r, 'CDN-Cache-Control'), /no-store/, 'falta CDN-Cache-Control (Vercel)')
    assert.match(valorDe(r, 'Cloudflare-CDN-Cache-Control'), /no-store/, 'falta o header do Cloudflare')
  })

  test('o SW do assistente segue protegido igual', () => {
    // Ele já estava certo antes deste achado; o teste existe para que os dois
    // não voltem a divergir — foi a divergência que criou o buraco.
    const cc = valorDe(regraPara('/assistant-sw.js'), 'Cache-Control')
    assert.match(cc, /max-age=0/)
    assert.match(valorDe(regraPara('/assistant-sw.js'), 'Cloudflare-CDN-Cache-Control'), /no-store/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('nenhum arquivo SEM HASH pode ficar em cache longo', () => {
  // Arquivo com hash no nome pode (e deve) ser `immutable`: um conteúdo novo
  // ganha nome novo. Sem hash, o nome é estável e o cache longo congela a versão
  // — foi assim que o `sw.js` ficou preso ao deploy anterior.
  const CRITICOS = ['/sw.js', '/registerSW.js', '/sw-push-handler.js', '/pwa-init.js']

  for (const caminho of CRITICOS) {
    test(`${caminho} revalida em vez de cachear`, () => {
      const cc = valorDe(regraPara(caminho), 'Cache-Control')
      assert.ok(cc, `${caminho} não tem regra de Cache-Control`)
      assert.doesNotMatch(cc, /max-age=(?!0\b)\d+/,
        `${caminho} tem cache longo ("${cc}") e o nome não muda entre deploys`)
    })
  }

  test('varre o build de verdade, se ele existir', () => {
    const dist = join(RAIZ, 'dist')
    if (!existsSync(dist)) return // CI sem build: os casos críticos acima já cobrem

    const soltos = readdirSync(dist).filter((f) => f.endsWith('.js') && semHash(f))
    assert.ok(soltos.length, 'nenhum .js sem hash no dist — o teste perdeu o alvo')

    const expostos = soltos.filter((f) => {
      const cc = valorDe(regraPara('/' + f), 'Cache-Control')
      return /max-age=(?!0\b)\d+/.test(cc) || !cc
    })

    assert.deepEqual(
      expostos, [],
      `arquivos SEM HASH com cache longo (ou sem regra): ${expostos.join(', ')}. ` +
      'O nome não muda entre deploys, então a CDN vai servir a versão antiga.',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('sem cache na rede, mas disponível offline', () => {
  // As duas metades do mesmo conserto, e uma sem a outra é um buraco novo:
  //   • `max-age=0, must-revalidate` na REDE impede servir versão congelada;
  //   • mas "não use sem revalidar" quebra offline, onde não há como revalidar.
  // Por isso os scripts de boot (sem hash no nome) precisam estar no precache:
  // lá o Workbox os versiona por REVISION — hash do conteúdo, não do nome.
  const CFG = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
  const BOOT = ['theme-init', 'css-boot', 'pwa-init', 'registerSW', 'sw-push-handler']

  test('⭐ os scripts de boot estão no globPatterns', () => {
    const bloco = CFG.slice(CFG.indexOf('globPatterns:'), CFG.indexOf('globIgnores:'))
    for (const f of BOOT) {
      assert.ok(bloco.includes(f),
        `${f} saiu do precache — com max-age=0 na rede, ele some no carregamento offline`)
    }
  })

  test('sw.js e assistant-sw.js NÃO entram no próprio precache', () => {
    const bloco = CFG.slice(CFG.indexOf('globIgnores:'), CFG.indexOf('globIgnores:') + 220)
    assert.match(bloco, /'sw\.js'/, 'o SW não pode precachear a si mesmo')
    assert.match(bloco, /'assistant-sw\.js'/, 'o SW do assistente tem ciclo de vida próprio')
  })

  test('o build de verdade confirma', () => {
    const sw = join(RAIZ, 'dist', 'sw.js')
    if (!existsSync(sw)) return
    const conteudo = readFileSync(sw, 'utf8')
    for (const f of BOOT) {
      assert.match(conteudo, new RegExp(`"${f}\.js"`), `${f}.js não foi precacheado no build`)
    }
    assert.doesNotMatch(conteudo, /"sw\.js"/)
    assert.doesNotMatch(conteudo, /"assistant-sw\.js"/)
  })
})
