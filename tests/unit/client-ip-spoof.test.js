/**
 * SEC-003 — DE QUEM É ESTA REQUISIÇÃO, para efeito de rate limit.
 *
 * O achado original (17/08) tinha DUAS metades, e uma delas estava errada:
 *
 *   (a) ERRADA — "`x-forwarded-for.split(',')[0]` é forjável". Não é. A doc da
 *       Vercel diz que ela SOBRESCREVE x-forwarded-for / x-real-ip /
 *       x-vercel-forwarded-for e "does not forward external IPs ... to prevent
 *       IP spoofing". O split era inútil, não inseguro.
 *
 *   (b) CERTA — `cf-connecting-ip` não era lido, e com Cloudflare na frente
 *       todos os usuários colapsam nos poucos IPs do edge dela.
 *
 * A primeira tentativa de corrigir (b) passou a confiar em `cf-connecting-ip`
 * INCONDICIONALMENTE — e como a origem da Vercel responde direto (medido: a URL
 * `*-granadevs-projects.vercel.app` devolve 200 sem Cloudflare), isso CRIOU a
 * capacidade que (a) só imaginava: escolher o próprio IP de rate limit.
 *
 * O QUE ESTE ARQUIVO PROTEGE:
 *   1. que `cf-connecting-ip` só valha quando o PAR TCP for a Cloudflare;
 *   2. que o acesso direto à origem NÃO consiga forjar identidade;
 *   3. que o resultado seja um IP de verdade (ele vira chave de Redis);
 *   4. que a degradação seja RUIDOSA (agrupar) e nunca PERMISSIVA (aceitar
 *      qualquer coisa) — é a diferença entre um incômodo e um bypass;
 *   5. que nenhuma rota volte a derivar IP na mão.
 *
 * O item 5 é sobre o fonte. Comentário sai ANTES de casar.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { identidadeDeRede, ipDoCliente, ehIP, ehCloudflare } from '../../api/_client-ip.js'

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

// Um IP real do edge da Cloudflare (dentro de 172.64.0.0/13) e um que não é.
const CF_EDGE = '172.67.214.193'      // resolvido de www.granaevo.com em 17/08
const CF_EDGE2 = '104.21.24.3'        // idem
const NAO_CF = '203.0.113.9'          // TEST-NET-3, nunca da Cloudflare

// ─────────────────────────────────────────────────────────────────────────────
describe('reconhecer o edge da Cloudflare', () => {
  test('IPs reais do edge são reconhecidos', () => {
    for (const ip of [CF_EDGE, CF_EDGE2, '173.245.48.1', '162.158.0.1', '131.0.72.1']) {
      assert.equal(ehCloudflare(ip), true, `deveria reconhecer ${ip}`)
    }
  })

  test('IPv6 da Cloudflare é reconhecido', () => {
    assert.equal(ehCloudflare('2606:4700:3032::ac43:d6c1'), true)
    assert.equal(ehCloudflare('2400:cb00::1'), true)
    assert.equal(ehCloudflare('2a06:98c0::1'), true)
  })

  test('quem NÃO é Cloudflare não passa', () => {
    for (const ip of [NAO_CF, '8.8.8.8', '1.1.1.1', '192.168.0.1', '2001:db8::1']) {
      assert.equal(ehCloudflare(ip), false, `não deveria reconhecer ${ip}`)
    }
  })

  test('BORDA: o vizinho de uma faixa fica de fora', () => {
    // 173.245.48.0/20 termina em 173.245.63.255
    assert.equal(ehCloudflare('173.245.63.255'), true, 'último da faixa está dentro')
    assert.equal(ehCloudflare('173.245.64.0'), false, 'o próximo já está fora')
    // 104.16.0.0/13 termina em 104.23.255.255
    assert.equal(ehCloudflare('104.23.255.255'), true)
    assert.equal(ehCloudflare('104.32.0.0'), false)
  })

  test('lixo não vira Cloudflare', () => {
    for (const x of ['', '   ', 'nao-eh-ip', null, undefined, 42, {}, '999.1.1.1']) {
      assert.equal(ehCloudflare(x), false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('O VETOR: acesso direto à origem não escolhe a própria identidade', () => {
  test('cf-connecting-ip forjado é IGNORADO quando o par não é Cloudflare', () => {
    const r = identidadeDeRede(req({
      'cf-connecting-ip':        '198.51.100.7',   // o que o atacante quer ser
      'x-vercel-forwarded-for':  NAO_CF,           // quem ele é de verdade (Vercel escreve)
    }))
    assert.equal(r.ip, NAO_CF, 'tem de usar o IP real do par, não o header forjado')
    assert.notEqual(r.ip, '198.51.100.7')
    assert.equal(r.viaCloudflare, false)
  })

  test('nem com x-forwarded-for/x-real-ip no lugar do header da Vercel', () => {
    for (const campo of ['x-forwarded-for', 'x-real-ip']) {
      const r = identidadeDeRede(req({
        'cf-connecting-ip': '198.51.100.7',
        [campo]:            NAO_CF,
      }))
      assert.equal(r.ip, NAO_CF, `${campo}: o forjado não pode vencer`)
    }
  })

  test('atacante que TAMBÉM forja o header da Vercel não ganha nada', () => {
    // A Vercel sobrescreve estes headers, então isto não acontece em produção.
    // Mas se acontecesse, o resultado ainda seria um IP de verdade, não o escolhido.
    const r = identidadeDeRede(req({
      'cf-connecting-ip':       '198.51.100.7',
      'x-vercel-forwarded-for': 'nao-eh-ip',
      'x-forwarded-for':        NAO_CF,
    }))
    assert.equal(r.ip, NAO_CF)
  })
})

describe('pelo caminho normal, cada usuário tem a própria identidade', () => {
  test('par É Cloudflare → cf-connecting-ip vale', () => {
    const r = identidadeDeRede(req({
      'cf-connecting-ip':       '198.51.100.7',
      'x-vercel-forwarded-for': CF_EDGE,
    }))
    assert.equal(r.ip, '198.51.100.7')
    assert.equal(r.fonte, 'cf-connecting-ip')
    assert.equal(r.viaCloudflare, true)
    assert.equal(r.confiavel, true)
  })

  test('DEGRADAÇÃO RUIDOSA: veio da Cloudflare sem o header → usa o edge', () => {
    // Agrupa usuários (limite fica chato), mas ninguém escolhe identidade.
    const r = identidadeDeRede(req({ 'x-vercel-forwarded-for': CF_EDGE }))
    assert.equal(r.ip, CF_EDGE)
    assert.match(r.fonte, /cf-sem-header/)
    assert.equal(r.viaCloudflare, true)
  })

  test('cf-connecting-ip com lixo, vindo da Cloudflare, cai no edge', () => {
    const r = identidadeDeRede(req({
      'cf-connecting-ip':       'DROP TABLE users',
      'x-vercel-forwarded-for': CF_EDGE,
    }))
    assert.equal(r.ip, CF_EDGE, 'nunca a string do atacante')
  })

  test('sem nada utilizável → unknown', () => {
    assert.equal(identidadeDeRede(req({})).ip, 'unknown')
    assert.equal(identidadeDeRede({}).ip, 'unknown')
  })

  test('socket como último recurso', () => {
    const r = identidadeDeRede(req({}, { remoteAddress: NAO_CF }))
    assert.equal(r.ip, NAO_CF)
    assert.equal(r.fonte, 'socket')
  })
})

describe('o valor vira CHAVE de Redis — precisa ser um IP', () => {
  test('aceita IPv4 e IPv6 reais', () => {
    assert.ok(ehIP('203.0.113.9'))
    assert.ok(ehIP('2001:db8::1'))
    assert.ok(ehIP('::1'))
    assert.ok(ehIP('::ffff:192.0.2.1'))
  })

  test('recusa o que serviria para escolher a chave alheia', () => {
    for (const mau of [
      '999.1.1.1', '1.2.3.4.5', '', '   ', 'unknown', 'a'.repeat(60),
      'accept-terms:203.0.113.9', '203.0.113.9 OR 1=1',
      '::::1', 'z::1', null, undefined, 42, {},
    ]) {
      assert.equal(ehIP(mau), false, `deveria recusar: ${String(mau)}`)
    }
  })

  test('IPv4 com porta e IPv6 em colchetes são normalizados', () => {
    assert.equal(identidadeDeRede(req({ 'x-forwarded-for': '203.0.113.9:51234' })).ip, '203.0.113.9')
    assert.equal(identidadeDeRede(req({ 'x-forwarded-for': '[2001:db8::1]' })).ip, '2001:db8::1')
  })

  test('ipDoCliente concorda com identidadeDeRede', () => {
    const hh = { 'cf-connecting-ip': '198.51.100.7', 'x-vercel-forwarded-for': CF_EDGE }
    assert.equal(ipDoCliente(req(hh)), identidadeDeRede(req(hh)).ip)
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
      if (/headers\[\s*['"](?:x-real-ip|x-forwarded-for|cf-connecting-ip|x-vercel-forwarded-for)['"]\s*\]/.test(src)) {
        reincidentes.push(f)
      }
    }

    assert.deepEqual(reincidentes, [],
      'estas rotas voltaram a ler o header de IP direto em vez de usar _client-ip.js')
  })
})
