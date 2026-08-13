/**
 * ACHADO-01 (auditoria 2026-08-12) — o `sub` do JWT só vale depois da assinatura.
 *
 * O QUE ESTE TESTE PRECISA PROVAR
 * ---------------------------------------------------------------------------
 * O proxy usava `sub` de um JWT decodificado sem verificação para montar chaves
 * de rate limit. Como contador é recurso da VÍTIMA, um `sub` forjado queimava a
 * cota de outra pessoa: ~8 min de um IP só derrubavam o assistente da vítima por
 * 24 h (`chatparse:uid:<vítima>:day`, teto 120).
 *
 * Não basta afirmar "agora verifica". O teste que importa é o adversarial:
 * assinar com a chave ERRADA e conferir que o veredito é CONCLUSIVAMENTE
 * inválido — porque é o `conclusivo` que faz o chamador devolver 401 antes de
 * encostar em qualquer contador.
 *
 * E prova também o outro lado, que é onde uma correção de segurança costuma abrir
 * o próximo buraco: com o JWKS fora do ar, o veredito precisa ser INCONCLUSIVO,
 * não "inválido". Inválido ali significaria 401 para todo mundo — um outage
 * total causado pela indisponibilidade de um endpoint de chaves.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as assinar, randomUUID } from 'node:crypto';

const SUPABASE_URL = 'https://projeto-de-teste.supabase.co';
const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;

const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** Gera um par ES256 e o JWK público correspondente. */
function parDeChaves(kid) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
    return { privateKey, jwk };
}

/** Monta um JWT ES256 assinado com `privateKey`. */
function montarJWT(privateKey, { kid, sub, exp, iss = `${SUPABASE_URL}/auth/v1`, alg = 'ES256' }) {
    const cabecalho = b64url({ alg, typ: 'JWT', kid });
    const corpo = b64url({
        sub,
        iss,
        exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
    });
    // ECDSA em JWT é R||S cru (IEEE P1363), não DER — igual ao verificador.
    const assinatura = assinar(
        'sha256',
        Buffer.from(`${cabecalho}.${corpo}`, 'utf8'),
        { key: privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');
    return `${cabecalho}.${corpo}.${assinatura}`;
}

describe('ACHADO-01 — identidade só depois da verificação criptográfica', () => {
    let verificarJWT, _resetarCacheJwks;
    let KID, chaveLegitima, chaveDoAtacante;
    let fetchOriginal;
    let jwksIndisponivel = false;

    before(async () => {
        process.env.SUPABASE_URL = SUPABASE_URL;
        KID = randomUUID();
        chaveLegitima   = parDeChaves(KID);
        // O atacante usa o MESMO kid: quer se passar pela chave do projeto.
        chaveDoAtacante = parDeChaves(KID);

        fetchOriginal = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (String(url) !== JWKS_URL) throw new Error('url inesperada: ' + url);
            if (jwksIndisponivel) throw new Error('ECONNREFUSED');
            return new Response(JSON.stringify({ keys: [chaveLegitima.jwk] }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        };

        ({ verificarJWT, _resetarCacheJwks } = await import('../../api/_jwt.js'));
    });

    after(() => { globalThis.fetch = fetchOriginal; });

    beforeEach(() => { jwksIndisponivel = false; _resetarCacheJwks(); });

    it('token legítimo: devolve o sub para uso em rate limit', async () => {
        const sub = randomUUID();
        const r = await verificarJWT(montarJWT(chaveLegitima.privateKey, { kid: KID, sub }));
        assert.equal(r.ok, true);
        assert.equal(r.sub, sub);
    });

    it('O ATAQUE: token assinado com outra chave, com o sub da vítima, é CONCLUSIVAMENTE inválido', async () => {
        const subDaVitima = randomUUID();
        const forjado = montarJWT(chaveDoAtacante.privateKey, { kid: KID, sub: subDaVitima });

        const r = await verificarJWT(forjado);

        assert.equal(r.ok, false, 'token forjado não pode ser aceito');
        // `conclusivo` é o que vira 401 no chamador — sem ele o request seguiria
        // adiante e o contador da vítima seria incrementado do mesmo jeito.
        assert.equal(r.conclusivo, true, 'precisa ser conclusivo para virar 401');
        assert.equal(r.motivo, 'assinatura');
        assert.equal(r.sub, undefined, 'nenhum sub pode vazar de token não verificado');
    });

    it('alg:none é ataque, não legado — conclusivo', async () => {
        const cabecalho = b64url({ alg: 'none', typ: 'JWT' });
        const corpo = b64url({ sub: randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 });
        const r = await verificarJWT(`${cabecalho}.${corpo}.`);
        assert.equal(r.ok, false);
        assert.equal(r.conclusivo, true);
        assert.equal(r.motivo, 'alg_none');
    });

    it('token expirado é conclusivamente inválido', async () => {
        const r = await verificarJWT(montarJWT(chaveLegitima.privateKey, {
            kid: KID, sub: randomUUID(), exp: Math.floor(Date.now() / 1000) - 600,
        }));
        assert.equal(r.ok, false);
        assert.equal(r.conclusivo, true);
        assert.equal(r.motivo, 'expirado');
    });

    it('emissor de outro projeto é conclusivamente inválido', async () => {
        const r = await verificarJWT(montarJWT(chaveLegitima.privateKey, {
            kid: KID, sub: randomUUID(), iss: 'https://outro-projeto.supabase.co/auth/v1',
        }));
        assert.equal(r.ok, false);
        assert.equal(r.conclusivo, true);
        assert.equal(r.motivo, 'iss');
    });

    it('A CORREÇÃO NÃO ABRE OUTRO BURACO: JWKS fora do ar é INCONCLUSIVO, não 401', async () => {
        jwksIndisponivel = true;
        const r = await verificarJWT(montarJWT(chaveLegitima.privateKey, { kid: KID, sub: randomUUID() }));

        assert.equal(r.ok, false, 'sem as chaves não há como afirmar que é válido');
        // Se isto virasse `conclusivo: true`, uma queda do endpoint de JWKS
        // devolveria 401 para TODOS os usuários — outage total causado pela
        // própria correção de segurança.
        assert.equal(r.conclusivo, false, 'indisponibilidade de terceiro não pode derrubar ninguém');
        assert.equal(r.sub, undefined, 'e também não pode conceder identidade');
    });

    it('alg não-ES256 fica inconclusivo (token legado segue pela edge, sem cota por usuário)', async () => {
        const cabecalho = b64url({ alg: 'HS256', typ: 'JWT' });
        const corpo = b64url({ sub: randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 });
        const r = await verificarJWT(`${cabecalho}.${corpo}.assinaturafalsa`);
        assert.equal(r.ok, false);
        assert.equal(r.conclusivo, false, 'um 401 aqui seria regressão em token legado válido');
    });

    it('cache do JWKS: uma queda posterior não invalida token já verificável', async () => {
        const sub = randomUUID();
        const token = montarJWT(chaveLegitima.privateKey, { kid: KID, sub });

        assert.equal((await verificarJWT(token)).ok, true);   // popula o cache
        jwksIndisponivel = true;                              // JWKS cai depois
        const r = await verificarJWT(token);

        assert.equal(r.ok, true, 'chave pública em cache continua verificando assinatura');
        assert.equal(r.sub, sub);
    });
});
