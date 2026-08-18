/**
 * _client-ip.js — de quem é esta requisição, para efeito de rate limit.
 * ---------------------------------------------------------------------------
 * SEC-003. A história completa importa, porque a primeira versão desta correção
 * (2026-08-17) errou o diagnóstico e ABRIU um buraco que não existia antes.
 *
 * ── O que se acreditava ────────────────────────────────────────────────────
 * As rotas faziam `(x-real-ip ?? x-forwarded-for).split(',')[0]`, e o primeiro
 * elemento de um XFF é o que a ponta escreveu. Parecia forjável.
 *
 * ── O que a documentação da Vercel diz de fato ──────────────────────────────
 * > x-forwarded-for: "If you are trying to use Vercel behind a proxy, we
 * >   currently OVERWRITE the X-Forwarded-For header and DO NOT FORWARD external
 * >   IPs. This restriction is in place to PREVENT IP SPOOFING."
 * > x-vercel-forwarded-for: "identical to x-forwarded-for. However,
 * >   x-forwarded-for could be overwritten if you're using a proxy on top of Vercel."
 * > x-real-ip: "identical to the x-forwarded-for header."
 *
 * Ou seja: `x-forwarded-for`, `x-real-ip` e `x-vercel-forwarded-for` são
 * ESCRITOS PELA VERCEL. O cliente não os forja. O `.split(',')[0]` nunca foi o
 * problema — só era inútil, porque a Vercel entrega um valor só.
 *
 * ── O problema REAL, e o que a primeira correção estragou ───────────────────
 * Com a Cloudflare na frente, o que a Vercel enxerga como cliente é o edge da
 * Cloudflare: todos os usuários colapsam em meia dúzia de IPs, e o limite por IP
 * deixa de separar pessoas. `cf-connecting-ip` resolve isso — mas ele NÃO é um
 * header da Vercel, e portanto NÃO é protegido contra spoofing.
 *
 * A primeira versão passou a confiar em `cf-connecting-ip` incondicionalmente. E
 * a origem da Vercel é alcançável direto (medido em 2026-08-17: a URL
 * `granaevo-<hash>-granadevs-projects.vercel.app` responde 200, sem Cloudflare e
 * sem autenticação). Quem falasse com a origem por fora passava a ESCOLHER o
 * próprio IP de rate limit — capacidade que não existia antes daquela mudança.
 *
 * ── A regra que vale ────────────────────────────────────────────────────────
 * `cf-connecting-ip` só vale quando o PAR TCP for a Cloudflare. Quem diz quem é
 * o par é a Vercel, pelos headers que ela mesma escreve. Se o par não estiver nas
 * faixas publicadas da Cloudflare, o header é ignorado — não importa o que diga.
 *
 * ── Modo de falha (de propósito, e é o seguro) ──────────────────────────────
 * Se a Cloudflare publicar faixas novas e esta lista envelhecer, o par deixa de
 * ser reconhecido e caímos no IP do par — que é o edge da Cloudflare. Resultado:
 * o limite volta a agrupar usuários (chato, visível, corrigível) em vez de aceitar
 * um IP inventado (silencioso e explorável). Degrada para RUIDOSO, nunca para
 * PERMISSIVO. O log de `fonte` deixa isso diagnosticável.
 *
 * Faixas de https://www.cloudflare.com/ips-v4 e /ips-v6, buscadas em 2026-08-17.
 * ---------------------------------------------------------------------------
 */

const CF_IPV4 = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]

const CF_IPV6 = [
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

/** IPv4 pontuado. Estrito: rejeita 999.1.1.1 e 1.2.3.4.5. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

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
    return v.includes(':') && ehIPv6(v)
}

function ehIPv6(v) {
    if (!/^[0-9a-f:.]+$/i.test(v)) return false
    if ((v.match(/::/g) ?? []).length > 1) return false
    return paraBigInt6(v) !== null
}

/** IPv4 pontuado → inteiro de 32 bits. */
function paraInt4(ip) {
    const p = ip.split('.')
    if (p.length !== 4) return null
    let n = 0
    for (const octeto of p) {
        const x = Number(octeto)
        if (!Number.isInteger(x) || x < 0 || x > 255) return null
        n = n * 256 + x
    }
    return n
}

/** IPv6 (incl. `::` comprimido e cauda IPv4) → BigInt de 128 bits. */
function paraBigInt6(ip) {
    let corpo = ip
    // Cauda no formato ::ffff:1.2.3.4 — converte os 4 octetos em dois grupos hex.
    const m = corpo.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/)
    if (m) {
        const v4 = paraInt4(m[2])
        if (v4 === null) return null
        corpo = m[1] +
            ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16)
    }

    const partes = corpo.split('::')
    if (partes.length > 2) return null

    const cabeca = partes[0] ? partes[0].split(':') : []
    const cauda = partes.length === 2 ? (partes[1] ? partes[1].split(':') : []) : null

    let grupos
    if (cauda === null) {
        if (cabeca.length !== 8) return null
        grupos = cabeca
    } else {
        const faltam = 8 - cabeca.length - cauda.length
        if (faltam < 0) return null
        grupos = [...cabeca, ...Array(faltam).fill('0'), ...cauda]
    }

    let n = 0n
    for (const g of grupos) {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
        n = (n << 16n) | BigInt(parseInt(g, 16))
    }
    return n
}

/** O IP está dentro do CIDR? Trata v4 e v6; mistura de família devolve false. */
function dentroDoCidr(ip, cidr) {
    const [rede, bitsTxt] = cidr.split('/')
    const bits = Number(bitsTxt)

    if (IPV4.test(ip) && IPV4.test(rede)) {
        const a = paraInt4(ip), b = paraInt4(rede)
        if (a === null || b === null || bits < 0 || bits > 32) return false
        if (bits === 0) return true
        // `>>> 0` porque deslocamento em JS opera com 32 bits COM sinal: sem isso,
        // /1 vira número negativo e a comparação erra em toda faixa alta.
        const mascara = (~((1 << (32 - bits)) - 1)) >>> 0
        return ((a & mascara) >>> 0) === ((b & mascara) >>> 0)
    }

    if (ip.includes(':') && rede.includes(':')) {
        const a = paraBigInt6(ip), b = paraBigInt6(rede)
        if (a === null || b === null || bits < 0 || bits > 128) return false
        const deslocamento = BigInt(128 - bits)
        return (a >> deslocamento) === (b >> deslocamento)
    }

    return false
}

/** O par TCP é a Cloudflare? Só então `cf-connecting-ip` significa alguma coisa. */
export function ehCloudflare(ip) {
    if (!ehIP(ip)) return false
    const v = ip.trim()
    const faixas = IPV4.test(v) ? CF_IPV4 : CF_IPV6
    return faixas.some((c) => dentroDoCidr(v, c))
}

/** Primeiro header presente, já normalizado para string. */
function h(req, nome) {
    const v = req?.headers?.[nome]
    if (Array.isArray(v)) return v.join(',')
    return typeof v === 'string' ? v : ''
}

/** Último IP válido de uma lista de XFF — o que o proxy mais próximo observou. */
function ultimoDaLista(valor) {
    const partes = valor.split(',').map((s) => s.trim()).filter(Boolean)
    for (let i = partes.length - 1; i >= 0; i--) {
        const limpo = partes[i]
            .replace(/^\[|\]$/g, '')
            .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1')
        if (ehIP(limpo)) return limpo
    }
    return ''
}

/**
 * O IP do PAR — quem abriu a conexão com a Vercel. Só headers que a Vercel
 * escreve entram aqui; nenhum deles é forjável pelo cliente (ver doc no topo).
 */
function ipDoPar(req) {
    const vercel = ultimoDaLista(h(req, 'x-vercel-forwarded-for'))
    if (vercel) return { ip: vercel, fonte: 'x-vercel-forwarded-for' }

    const xff = ultimoDaLista(h(req, 'x-forwarded-for'))
    if (xff) return { ip: xff, fonte: 'x-forwarded-for' }

    const real = h(req, 'x-real-ip').trim()
    if (ehIP(real)) return { ip: real, fonte: 'x-real-ip' }

    const sock = req?.socket?.remoteAddress
    if (ehIP(sock)) return { ip: String(sock).trim(), fonte: 'socket' }

    return { ip: '', fonte: 'nenhuma' }
}

/**
 * @returns {{ ip: string, fonte: string, confiavel: boolean, viaCloudflare: boolean }}
 *   `ip` é 'unknown' quando nada utilizável chegou.
 */
export function identidadeDeRede(req) {
    const par = ipDoPar(req)

    // Só há motivo para olhar cf-connecting-ip se quem falou conosco FOI a
    // Cloudflare. Vindo de qualquer outro lugar, o header é texto do atacante.
    if (par.ip && ehCloudflare(par.ip)) {
        const cf = h(req, 'cf-connecting-ip').trim()
        if (ehIP(cf)) {
            return { ip: cf, fonte: 'cf-connecting-ip', confiavel: true, viaCloudflare: true }
        }
        // Veio da Cloudflare sem o header (ou com lixo): fica o edge dela. Agrupa
        // usuários, mas não deixa ninguém escolher a própria identidade.
        return { ip: par.ip, fonte: `${par.fonte}(cf-sem-header)`, confiavel: true, viaCloudflare: true }
    }

    if (par.ip) {
        // Acesso direto à origem, sem passar pela Cloudflare. O IP é o real de
        // quem chamou — e um cf-connecting-ip forjado é ignorado aqui.
        return { ip: par.ip, fonte: par.fonte, confiavel: true, viaCloudflare: false }
    }

    // 'unknown' é uma chave de Redis ÚNICA compartilhada por todo mundo; o
    // primeiro abusador trancaria os demais. Só se chega aqui sem nenhum header.
    return { ip: 'unknown', fonte: 'nenhuma', confiavel: false, viaCloudflare: false }
}

/** Só o endereço — para os call sites que não decidem nada com a procedência. */
export function ipDoCliente(req) {
    return identidadeDeRede(req).ip
}
