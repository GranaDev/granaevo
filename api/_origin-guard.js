/**
 * _origin-guard.js — a API só atende quem veio pela Cloudflare.
 * ---------------------------------------------------------------------------
 * SEC-003, segunda metade. A primeira fechou a FORJA DE IP; esta fecha o
 * BYPASS DA CAMADA.
 *
 * Medido em 2026-08-17:
 *
 *   curl --resolve www.granaevo.com:443:64.29.17.194 https://www.granaevo.com/
 *   → HTTP 200 · Server: Vercel · X-Vercel-Id presente · sem CF-RAY
 *
 * Qualquer pessoa alcança a origem apontando o domínio para um IP da borda da
 * Vercel. Não precisa nem descobrir a URL `*.vercel.app`: os IPs da Vercel são
 * públicos. Por isso o "Standard Protection" da Vercel NÃO resolve — ele protege
 * as URLs geradas, não o domínio custom servido pela borda. E "Trusted IPs", que
 * resolveria, é exclusivo do plano Enterprise.
 *
 * O que se ganha atravessando por fora: WAF, rate limiting e proteção de DDoS da
 * Cloudflare inteiros. As defesas do app continuam valendo (auth, RLS, rate limit
 * por IP real), mas uma camada some sem deixar rastro.
 *
 * ── POR QUE ISTO NÃO PRECISA DE SEGREDO COMPARTILHADO ──────────────────────
 * O caminho óbvio seria uma Transform Rule na Cloudflare injetando um header
 * secreto. Isso funciona, mas cria duas fontes de verdade (a regra e a env var)
 * que precisam ser mantidas em sincronia — e some num restore da zona.
 *
 * Não é necessário: quem abriu a conexão com a Vercel já é um dado confiável.
 * A doc da Vercel diz que ela SOBRESCREVE `x-forwarded-for` / `x-real-ip` /
 * `x-vercel-forwarded-for` e "does not forward external IPs ... to prevent IP
 * spoofing". Então o IP do par é fato, não alegação — e se ele está nas faixas
 * publicadas da Cloudflare, a requisição veio de lá. Uma fonte de verdade só,
 * a mesma lista de CIDR que `_client-ip.js` já usa e que já tem teste de borda.
 *
 * ── TRÊS MODOS, porque ligar isto de uma vez é imprudente ───────────────────
 *   EXIGIR_CLOUDFLARE ausente  → desligado. Estado idêntico ao de antes.
 *   EXIGIR_CLOUDFLARE=shadow   → não bloqueia, só registra a decisão. É como se
 *                                descobre se algum tráfego legítimo chegaria por
 *                                fora ANTES de ele começar a levar 403.
 *   EXIGIR_CLOUDFLARE=1        → bloqueia com 403.
 *
 * A env var é também o botão de emergência: removê-la no painel da Vercel desliga
 * a trava sem precisar de deploy.
 *
 * ── MODO DE FALHA ──────────────────────────────────────────────────────────
 * Se a Cloudflare publicar faixas novas e a lista de `_client-ip.js` envelhecer,
 * tráfego legítimo passa a ser recusado. É por isso que existe o modo `shadow` e
 * o desligamento por env var — e por isso o log diz qual IP foi recusado, que é a
 * informação necessária para atualizar a lista.
 * ---------------------------------------------------------------------------
 */

import { identidadeDeRede } from './_client-ip.js'

const MODO = process.env.EXIGIR_CLOUDFLARE ?? ''

/**
 * Chamar no TOPO do handler, antes de qualquer lógica.
 *
 * @returns {boolean} true se já respondeu (o handler deve retornar imediatamente).
 */
export function bloquearOrigemDireta(req, res, rota = '') {
    if (MODO !== 'shadow' && MODO !== '1') return false

    const id = identidadeDeRede(req)
    if (id.viaCloudflare) return false

    // OPTIONS de CORS não carrega dado e recusá-lo confunde o navegador em
    // qualquer diagnóstico futuro. O que interessa barrar é o método com efeito.
    if (req.method === 'OPTIONS') return false

    console.warn(JSON.stringify({
        level: MODO === '1' ? 'warn' : 'info',
        event: MODO === '1' ? 'origem_direta_bloqueada' : 'origem_direta_detectada_shadow',
        path: rota || req.url || '',
        ip: id.ip,
        fonte: id.fonte,
        timestamp: new Date().toISOString(),
    }))

    if (MODO === 'shadow') return false

    res.status(403).json({ error: 'Forbidden' })
    return true
}

/** Para teste e diagnóstico: qual modo está ativo. */
export function modoDaGuarda() {
    return MODO === '1' ? 'bloqueando' : MODO === 'shadow' ? 'shadow' : 'desligado'
}
