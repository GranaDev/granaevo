/**
 * FASE B / B1 — o critério fundamental, provado OFFLINE.
 *
 *     JWT adulterado → 401 → contador da VÍTIMA inalterado
 *
 * Este é o teste que fecha o ACHADO-01 experimentalmente, e ele não precisa de
 * ambiente dedicado: o envenenamento acontecia inteiro dentro do proxy, antes de
 * qualquer chamada de rede. Martelar um servidor real provaria a mesma coisa com
 * muito mais efeito colateral.
 *
 * COMO O CONTADOR É OBSERVADO
 * ---------------------------------------------------------------------------
 * Sem Upstash configurado, `_rate-limit.js` usa o Map em memória do próprio
 * processo. O teste importa `checkRateWindow` do MESMO módulo que o handler usa
 * (o cache de módulos ESM garante a mesma instância), então consegue medir o
 * contador da vítima diretamente — em vez de inferir por efeito colateral.
 *
 * `RL_MAX_USER_POST` é 8. Com o contador intocado, oito chamadas seguidas passam
 * e a nona é recusada. Se o ataque tiver envenenado K unidades, só passam 8−K.
 * A diferença é mensurável, não interpretativa.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign as assinar, randomUUID } from 'node:crypto';

const SUPABASE_URL = 'https://projeto-de-teste.supabase.co';
const JWKS_URL     = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
const ORIGIN       = 'https://granaevo.com';
const RL_MAX_USER_POST = 8;   // MANTER EM SINCRONIA com api/user-data.js

const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function fakeReq(corpo, headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(corpo), 'utf8')]);
    req.method = 'POST';
    req.query = {};
    req.headers = {
        origin: ORIGIN,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (teste de aceite B1)',
        'x-real-ip': '198.51.100.42',
        ...headers,
    };
    req.socket = { remoteAddress: '198.51.100.42' };
    return req;
}

function fakeRes() {
    return {
        statusCode: 0, corpo: undefined, headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(o) { this.corpo = o; return this; },
        send(o) { this.corpo = o; return this; },
        end() { return this; },
    };
}

describe('FASE B / B1 — envenenamento de cota alheia', () => {
    let handler, checkRateWindow;
    let chaveLegitima, chaveDoAtacante, KID;
    let edgeFoiChamada = false;
    let jwksIndisponivel = false;

    /** Quantas permissões RESTAM na cota de um sub (8 = intocada). */
    async function cotaRestante(sub) {
        let n = 0;
        for (let i = 0; i < RL_MAX_USER_POST; i++) {
            if (await checkRateWindow(`uid:${sub}`, RL_MAX_USER_POST, 60)) n++;
        }
        return n;
    }

    /** Monta um JWT ES256 assinado com a chave dada. */
    function jwt(privateKey, sub, { alg = 'ES256' } = {}) {
        const cab = b64url({ alg, typ: 'JWT', kid: KID });
        const cor = b64url({ sub, iss: `${SUPABASE_URL}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 });
        if (alg === 'none') return `${cab}.${cor}.`;
        const sig = assinar('sha256', Buffer.from(`${cab}.${cor}`, 'utf8'),
            { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        return `${cab}.${cor}.${sig}`;
    }

    const post = async (token, ip = '198.51.100.42') => {
        const res = fakeRes();
        await handler(fakeReq({ profiles: [] }, {
            authorization: `Bearer ${token}`, 'x-real-ip': ip,
        }), res);
        return res;
    };

    before(async () => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.SUPABASE_URL                = SUPABASE_URL;
        process.env.SUPABASE_ANON_KEY           = 'sb_publishable_teste';
        process.env.ALLOWED_ORIGIN              = ORIGIN;
        process.env.SUPABASE_PROJECT_REF        = 'projeto-de-teste';
        process.env.PROXY_SECRET                = 'segredo-de-teste';
        process.env.SUPABASE_EDGE_URL           = `${SUPABASE_URL}/functions/v1/save-user-data`;
        process.env.SUPABASE_GET_DATA_EDGE_URL  = `${SUPABASE_URL}/functions/v1/get-user-data`;

        KID = randomUUID();
        // A chave LEGÍTIMA do "projeto": é ela que vai para o JWKS.
        const legitima = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        chaveLegitima = legitima.privateKey;
        const jwkLegitimo = { ...legitima.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };
        // O atacante assina com OUTRA chave, reusando o mesmo kid.
        chaveDoAtacante = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

        globalThis.fetch = async (url) => {
            const u = String(url);
            if (u === JWKS_URL) {
                if (jwksIndisponivel) throw new Error('ECONNREFUSED');
                return new Response(JSON.stringify({ keys: [jwkLegitimo] }), { status: 200 });
            }
            // Se a requisição forjada chegar até aqui, o ataque passou do proxy.
            edgeFoiChamada = true;
            return new Response(JSON.stringify({ error: 'auth' }), { status: 401 });
        };

        ({ default: handler } = await import('../../api/user-data.js'));
        ({ checkRateWindow }  = await import('../../api/_rate-limit.js'));
    });

    // ── CONTROLE POSITIVO ────────────────────────────────────────────────────
    // Sem isto, "a cota da vítima não subiu" seria compatível com "o contador
    // está quebrado e nunca sobe para ninguém" — e o teste passaria por acidente.
    // Provar primeiro que o mecanismo FUNCIONA é o que dá sentido ao negativo.
    it('POSITIVO: JWT legítimo de A → sub = A → a cota de A DIMINUI', async () => {
        const usuarioA = randomUUID();

        const res = await post(jwt(chaveLegitima, usuarioA));
        // A edge (stub) reprova, mas o contador já foi tocado antes dela — que é
        // exatamente o comportamento esperado para um token verificado.
        assert.equal(res.statusCode, 401, 'a edge stub reprova; o que importa é o contador');

        assert.equal(await cotaRestante(usuarioA), RL_MAX_USER_POST - 1,
            'JWT legítimo TEM de consumir a cota do próprio dono — se não consome, o teste negativo não vale nada');
    });

    // ── O ATAQUE ─────────────────────────────────────────────────────────────
    it('NEGATIVO: 5 JWTs forjados com sub = A → 401 → cota de A INALTERADA', async () => {
        const usuarioA = randomUUID();
        const forjado  = jwt(chaveDoAtacante, usuarioA);   // assinatura de outra chave

        edgeFoiChamada = false;
        for (let i = 0; i < 5; i++) {
            const res = await post(forjado);
            assert.equal(res.statusCode, 401, `requisição forjada #${i + 1} deveria ser 401`);
        }

        assert.equal(edgeFoiChamada, false,
            'requisição forjada não pode nem chegar à Edge Function');

        // Se o ataque tivesse tocado `uid:A`, sobrariam 8−5 = 3.
        assert.equal(await cotaRestante(usuarioA), RL_MAX_USER_POST,
            'a cota da vítima foi envenenada');
    });

    it('NEGATIVO: alg:none com sub = A também não encosta na cota de A', async () => {
        const usuarioA = randomUUID();

        const res = await post(jwt(null, usuarioA, { alg: 'none' }));
        assert.equal(res.statusCode, 401);
        assert.equal(await cotaRestante(usuarioA), RL_MAX_USER_POST);
    });

    // ── INCONCLUSIVO ─────────────────────────────────────────────────────────
    // O caso descoberto durante a implementação: se o JWKS cai, não dá para
    // afirmar nada sobre o token. A resposta não pode ser inventar identidade
    // (envenenaria) nem devolver 401 (derrubaria todo mundo).
    it('INCONCLUSIVO: JWKS fora do ar → sub não é usado → cota de ninguém é contaminada', async () => {
        const usuarioA = randomUUID();
        const tokenBom = jwt(chaveLegitima, usuarioA);   // token VÁLIDO, mas sem como verificar

        // O cache de chaves precisa estar FRIO. Com ele quente a verificação
        // continua funcionando durante a queda — que é o comportamento desejado
        // e já coberto em jwt-verificacao.test.js. O caminho inconclusivo real é
        // o da instância serverless que nasce com o JWKS já fora do ar.
        const { _resetarCacheJwks } = await import('../../api/_jwt.js');
        _resetarCacheJwks();

        jwksIndisponivel = true;
        edgeFoiChamada = false;
        try {
            for (let i = 0; i < 3; i++) await post(tokenBom);
        } finally {
            jwksIndisponivel = false;
        }

        // A autoridade passa a ser a edge — é ela quem valida de verdade.
        assert.equal(edgeFoiChamada, true,
            'inconclusivo não pode virar 401 no proxy: a edge tem de decidir');

        // E nenhuma cota por usuário é movida, porque não há identidade confiável.
        assert.equal(await cotaRestante(usuarioA), RL_MAX_USER_POST,
            'sem verificação não pode haver contador por usuário — nem a favor, nem contra');

        // A proteção que RESTA é a por IP, e ela continua de pé.
        const { redisDegradado } = await import('../../api/_rate-limit.js');
        assert.equal(typeof redisDegradado, 'function');
    });
});
