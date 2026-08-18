/**
 * SEC-003 — DE QUEM É ESTA REQUISIÇÃO, para efeito de rate limit.
 *
 * Achado de 2026-08-17. Nove rotas em `api/` faziam:
 *
 *     (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
 *       .toString().split(',')[0].trim()
 *
 * `.split(',')[0]` é o PRIMEIRO elemento do X-Forwarded-For. Num XFF
 * `cliente, proxy1, proxy2`, cada proxy ACRESCENTA o endereço que viu — então o
 * primeiro elemento é exatamente o pedaço que a ponta escreveu, e o único que o
 * atacante controla. E `cf-connecting-ip` não era lido em lugar nenhum, apesar
 * da Cloudflare estar na frente.
 *
 * O QUE ESTE ARQUIVO PROTEGE:
 *   1. que o valor escolhido seja o do proxy mais próximo, nunca o da ponta;
 *   2. que `cf-connecting-ip` tenha precedência quando existir;
 *   3. que o resultado seja um IP DE VERDADE — ele vira chave de Redis, e chave
 *      escolhida pelo atacante permite colidir com a de outra pessoa;
 *   4. que nenhuma rota volte a derivar IP na mão (a regra tem UMA autoridade).
 *
 * O item 4 é sobre o fonte. Comentário sai ANTES de casar.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { identidadeDeRede, ipDoCliente, ehIP } from '../../api/_client-ip.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function semComentarios(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

const req = (headers, socket) => ({ headers, socket })

// ─────────────────────────────────────────────────────────────────────────────
describe('o elemento escolhido do X-Forwarded-For', () => {
  test('O VETOR: o que a ponta escreveu NÃO é aceito', () => {
    // Atacante manda `1.2.3.4`; a borda acrescenta o IP real dele.
    const r = identidadeDeRede(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }))
    assert.equal(r.ip, '203.0.113.9', 'tem de pegar o ÚLTIMO, não o forjado')
    assert.notEqual(r.ip, '1.2.3.4')
  })

  test('cadeia longa: sempre o último válido', () => {
    const r = identidadeDeRede(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }))
    assert.equal(r.ip, '203.0.113.9')
  })

  test('lixo no fim não derruba: cai para o último VÁLIDO', () => {
    const r = identidadeDeRede(req({ 'x-forwarded-for': '203.0.113.9, naoehip' }))
    assert.equal(r.ip, '203.0.113.9')
  })

  test('XFF só com lixo não vira IP', () => {
    const r = identidadeDeRede(req({ 'x-forwarded-for': 'sql injection, <script>' }))
    assert.equal(r.ip, 'unknown')
  })
})

describe('precedência das fontes', () => {
  test('cf-connecting-ip ganha de todo o resto', () => {
    const r = identidadeDeRede(req({
      'cf-connecting-ip':  '198.51.100.7',
      'x-forwarded-for':   '1.2.3.4, 203.0.113.9',
      'x-real-ip':         '10.0.0.1',
    }))
    assert.equal(r.ip, '198.51.100.7')
    assert.equal(r.fonte, 'cf-connecting-ip')
    assert.equal(r.confiavel, true)
  })

  test('cf-connecting-ip forjado com lixo é ignorado, não obedecido', () => {
    const r = identidadeDeRede(req({
      'cf-connecting-ip': 'nao-eh-ip',
      'x-forwarded-for':  '1.2.3.4, 203.0.113.9',
    }))
    assert.equal(r.ip, '203.0.113.9')
  })

  test('x-real-ip ainda funciona — e é marcado como não-confiável', () => {
    const r = identidadeDeRede(req({ 'x-real-ip': '198.51.100.42' }))
    assert.equal(r.ip, '198.51.100.42')
    assert.equal(r.confiavel, false, 'nada prova que a borda escreveu este header')
  })

  test('socket como último recurso', () => {
    const r = identidadeDeRede(req({}, { remoteAddress: '203.0.113.5' }))
    assert.equal(r.ip, '203.0.113.5')
    assert.equal(r.fonte, 'socket')
  })

  test('sem nada utilizável → unknown', () => {
    assert.equal(identidadeDeRede(req({})).ip, 'unknown')
    assert.equal(identidadeDeRede({}).ip, 'unknown')
  })
})

describe('o valor vira CHAVE de Redis — precisa ser um IP', () => {
  test('aceita IPv4 e IPv6 reais', () => {
    assert.ok(ehIP('203.0.113.9'))
    assert.ok(ehIP('2001:db8::1'))
    assert.ok(ehIP('::1'))
  })

  test('recusa o que serviria para escolher a chave alheia', () => {
    for (const mau of [
      '999.1.1.1', '1.2.3.4.5', '', '   ', 'unknown', 'a'.repeat(60),
      'accept-terms:203.0.113.9',           // tentativa de emendar a chave
      '203.0.113.9 OR 1=1', null, undefined, 42, {},
    ]) {
      assert.equal(ehIP(mau), false, `deveria recusar: ${String(mau)}`)
    }
  })

  test('IPv4 com porta e IPv6 em colchetes são normalizados', () => {
    assert.equal(identidadeDeRede(req({ 'x-forwarded-for': '203.0.113.9:51234' })).ip, '203.0.113.9')
    assert.equal(identidadeDeRede(req({ 'x-forwarded-for': '[2001:db8::1]' })).ip, '2001:db8::1')
  })

  test('ipDoCliente concorda com identidadeDeRede', () => {
    const h = { 'cf-connecting-ip': '198.51.100.7' }
    assert.equal(ipDoCliente(req(h)), identidadeDeRede(req(h)).ip)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('a regra tem UMA autoridade', () => {
  test('nenhuma rota em api/ deriva IP na mão', () => {
    const arquivos = readdirSync(join(RAIZ, 'api')).filter((f) => f.endsWith('.js'))
    const reincidentes = []

    for (const f of arquivos) {
      if (f === '_client-ip.js') continue   // é a autoridade
      const src = semComentarios(readFileSync(join(RAIZ, 'api', f), 'utf8'))
      // O padrão exato do achado: ler o header cru de IP fora do módulo.
      if (/headers\[\s*['"](?:x-real-ip|x-forwarded-for|cf-connecting-ip)['"]\s*\]/.test(src)) {
        reincidentes.push(f)
      }
    }

    assert.deepEqual(reincidentes, [],
      'estas rotas voltaram a ler o header de IP direto em vez de usar _client-ip.js')
  })
})
