/**
 * _client-ip.js — de quem é esta requisição, para efeito de rate limit.
 * ---------------------------------------------------------------------------
 * SEC-003 (auditoria 2026-08-17). Nove rotas em `api/` derivavam o IP assim:
 *
 *     (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
 *       .toString().split(',')[0].trim()
 *
 * Dois problemas, e o segundo é o grave:
 *
 * 1. `cf-connecting-ip` não era consultado em lugar nenhum — e há Cloudflare na
 *    frente. Quando o tráfego passa por ela, o que a Vercel enxerga como cliente
 *    é o edge da Cloudflare: TODOS os usuários compartilham um punhado de IPs, e
 *    o limite por IP deixa de separar pessoas.
 *
 * 2. `.split(',')[0]` pega o PRIMEIRO elemento do X-Forwarded-For. O XFF é
 *    `cliente, proxy1, proxy2`: cada proxy ACRESCENTA o endereço que ele viu. O
 *    primeiro elemento é o que a ponta mandou — ou seja, o único que o atacante
 *    controla. O último é o que o proxy imediatamente à nossa frente observou.
 *    Quem confia no primeiro escolheu justamente o campo forjável.
 *
 * O QUE ESTE MÓDULO NÃO RESOLVE SOZINHO — dito aqui para não virar falsa calma:
 * se a origem na Vercel for alcançável SEM passar pela Cloudflare, um atacante
 * fala direto com ela e inventa `cf-connecting-ip`. A defesa disso não é código,
 * é rede: Authenticated Origin Pulls (mTLS) ou um header secreto exigido na
 * origem. Enquanto isso não existir, este módulo entrega o melhor palpite
 * possível — e `identidadeDeRede()` marca `confiavel: false` quando o valor veio
 * de uma fonte que o cliente poderia ter inventado.
 * ---------------------------------------------------------------------------
 */

/** IPv4 pontuado. Estrito: rejeita 999.1.1.1 e 1.2.3.4.5. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
/** IPv6 em qualquer forma comprimida, com ou sem cauda IPv4. Deliberadamente permissivo no formato, restritivo no alfabeto. */
const IPV6 = /^[0-9a-f:]{2,45}$/i

/**
 * Um IP de verdade? Isto não é preciosismo: o valor vira CHAVE de Redis em
 * `checkRate(\`accept-terms:${ip}\`)`. Sem validar, um header arbitrário permite
 * escolher a chave alheia (colidir com a de outro) ou inflar o keyspace com lixo.
 */
export function ehIP(valor) {
    if (typeof valor !== 'string') return false
    const v = valor.trim()
    if (v === '' || v.length > 45) return false
    if (IPV4.test(v)) return true
    // IPv6 precisa de ':' — sem isso, "abcdef" passaria pelo alfabeto.
    return v.includes(':') && IPV6.test(v)
}

/** Primeiro header presente, já normalizado para string. */
function h(req, nome) {
    const v = req?.headers?.[nome]
    if (Array.isArray(v)) return v.join(',')
    return typeof v === 'string' ? v : ''
}

/**
 * O ÚLTIMO elemento de uma lista de XFF — o que o proxy mais próximo observou.
 * Nunca o primeiro: aquele é o que a ponta mandou.
 */
function ultimoDaLista(valor) {
    const partes = valor.split(',').map((s) => s.trim()).filter(Boolean)
    for (let i = partes.length - 1; i >= 0; i--) {
        // IPv6 em XFF às vezes vem como [::1]:443 — tira colchetes e porta.
        const limpo = partes[i].replace(/^\[|\]$/g, '').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')
        if (ehIP(limpo)) return limpo
    }
    return ''
}

/**
 * @returns {{ ip: string, fonte: string, confiavel: boolean }}
 *   `ip` é 'unknown' quando nada utilizável chegou. `confiavel` é false quando a
 *   fonte pode ter sido inventada pelo cliente (ver o aviso no cabeçalho).
 */
export function identidadeDeRede(req) {
    // 1. Cloudflare. Ela SOBRESCREVE qualquer cf-connecting-ip que o cliente
    //    mande, então o valor é dela — desde que a requisição tenha passado por
    //    ela, que é a premissa que a rede precisa garantir.
    const cf = h(req, 'cf-connecting-ip').trim()
    if (ehIP(cf)) return { ip: cf, fonte: 'cf-connecting-ip', confiavel: true }

    // 2. Header próprio da Vercel, escrito pela borda dela.
    const vercel = ultimoDaLista(h(req, 'x-vercel-forwarded-for'))
    if (vercel) return { ip: vercel, fonte: 'x-vercel-forwarded-for', confiavel: true }

    // 3. XFF pelo ÚLTIMO elemento (o que o proxy à nossa frente observou).
    const xff = ultimoDaLista(h(req, 'x-forwarded-for'))
    if (xff) return { ip: xff, fonte: 'x-forwarded-for(último)', confiavel: true }

    // 4. x-real-ip. Costuma ser escrito pela borda, mas nada aqui prova isso —
    //    por isso entra por último e marcado como não-confiável.
    const real = h(req, 'x-real-ip').trim()
    if (ehIP(real)) return { ip: real, fonte: 'x-real-ip', confiavel: false }

    // 5. Socket. Atrás de proxy costuma ser o proxy, mas é melhor que 'unknown':
    //    'unknown' é uma chave de Redis ÚNICA compartilhada por todo mundo, e aí
    //    o primeiro abusador tranca os demais.
    const sock = req?.socket?.remoteAddress
    if (ehIP(sock)) return { ip: String(sock).trim(), fonte: 'socket', confiavel: false }

    return { ip: 'unknown', fonte: 'nenhuma', confiavel: false }
}

/** Só o endereço — para os call sites que não decidem nada com a procedência. */
export function ipDoCliente(req) {
    return identidadeDeRede(req).ip
}
