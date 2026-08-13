/**
 * ACHADO-02 — critério de aceite das TRÊS camadas do lockout de login.
 *
 * "Escrita: sempre nas duas" é uma frase, não uma garantia. O que precisa ser
 * provado é a TABELA DE ESTADOS inteira, incluindo o terceiro — o que ninguém
 * costuma escrever:
 *
 *     Redis ok                     → proteção do Redis
 *     Redis fora, banco responde   → proteção do banco
 *     OS DOIS mudos                → NENHUMA camada contando falhas
 *
 * O terceiro é o que importa aqui. Uma camada não pode mascarar silenciosamente
 * a falha da outra: se ninguém está contando, o login NÃO pode seguir como se
 * estivesse protegido.
 *
 * A decisão registrada é degradar para um provedor INDEPENDENTE (captcha da
 * Cloudflare) em vez de remover a defesa ou trancar todos os clientes para fora.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const ORIGIN = 'https://granaevo.com';
const SUPABASE_URL = 'https://projeto-de-teste.supabase.co';
const EDGE_LOCKOUT = `${SUPABASE_URL}/functions/v1/login-lockout`;

/** `req` mínimo que satisfaz o leitor de corpo por stream do handler. */
function fakeReq(corpo, headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(corpo), 'utf8')]);
    req.method = 'POST';
    req.headers = {
        origin: ORIGIN,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (teste de aceite do lockout)',
        'x-real-ip': '203.0.113.77',
        ...headers,
    };
    req.socket = { remoteAddress: '203.0.113.77' };
    return req;
}

function fakeRes() {
    const r = {
        statusCode: 0, corpo: undefined, headers: {}, finalizado: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(o) { this.corpo = o; this.finalizado = true; return this; },
        send(o) { this.corpo = o; this.finalizado = true; return this; },
        end() { this.finalizado = true; return this; },
    };
    return r;
}

describe('ACHADO-02 — tabela de estados do lockout', () => {
    let handler;
    let chamadas;          // registro do que foi pedido à edge
    let respostaDaEdge;    // null = edge muda (falha)

    before(async () => {
        // SEM Upstash: `redisDegradado()` devolve true sempre — é assim que se
        // encena "o Redis não vale como decisão" sem depender de rede.
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        process.env.SUPABASE_URL      = SUPABASE_URL;
        process.env.SUPABASE_ANON_KEY = 'sb_publishable_teste';
        process.env.PROXY_SECRET      = 'segredo-de-teste';
        process.env.ALLOWED_ORIGIN    = ORIGIN;
        delete process.env.TURNSTILE_SECRET_KEY;   // captcha exigido, não validado aqui

        globalThis.fetch = async (url, init) => {
            const u = String(url);
            if (u === EDGE_LOCKOUT) {
                chamadas.push(JSON.parse(init.body));
                if (respostaDaEdge === null) throw new Error('edge fora do ar');
                return new Response(JSON.stringify(respostaDaEdge), { status: 200 });
            }
            if (u.includes('/auth/v1/token')) {
                // senha errada
                return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
            }
            throw new Error('url inesperada no teste: ' + u);
        };

        ({ default: handler } = await import('../../api/auth-session.js'));
    });

    beforeEach(() => { chamadas = []; respostaDaEdge = { ok: true, is_locked: false }; });

    const login = async (extra = {}) => {
        const res = fakeRes();
        await handler(fakeReq({
            action: 'login',
            email: `alvo-${Math.random().toString(36).slice(2)}@exemplo.com`,
            password: 'senha-errada-de-proposito',
            ...extra,
        }), res);
        return res;
    };

    it('ESTADO 2 — Redis fora, banco diz TRANCADO: o login é barrado', async () => {
        respostaDaEdge = { ok: true, is_locked: true, locked_until: new Date(Date.now() + 9e5).toISOString() };
        const res = await login();

        assert.equal(res.statusCode, 429);
        assert.equal(res.corpo?.error, 'account_locked');
        assert.equal(chamadas[0]?.acao, 'check', 'o banco precisa ser consultado quando o Redis degrada');
    });

    it('ESTADO 3 — Redis fora E banco mudo: NÃO passa livre, exige captcha', async () => {
        respostaDaEdge = null;   // edge fora do ar
        const res = await login();

        // O que NÃO pode acontecer: seguir para o password grant como se
        // estivesse protegido. Isso seria uma camada mascarando a falha da outra.
        assert.equal(res.statusCode, 403, 'sem nenhuma camada contando, o login não pode seguir normalmente');
        assert.equal(res.corpo?.error, 'captcha_required');
        assert.equal(res.corpo?.captcha_required, true);
    });

    it('ESTADO 3 — a exigência de captcha NÃO depende de nada que o cliente mande', async () => {
        respostaDaEdge = null;
        // Cliente tentando fingir que já resolveu o desafio antes: o gate é do
        // servidor, e um token vazio/forjado não o desliga.
        const res = await login({ captchaToken: '' });
        assert.equal(res.statusCode, 403);
        assert.equal(res.corpo?.error, 'captcha_required');
    });

    it('ESCRITA SEMPRE NAS DUAS — a falha de senha é registrada na camada durável', async () => {
        // Com captcha resolvido, o fluxo chega ao password grant (que o stub
        // reprova) e precisa registrar a falha NO BANCO, não só no Redis.
        respostaDaEdge = { ok: true, is_locked: false };
        const res = await login({ captchaToken: 'x'.repeat(40) });

        assert.equal(res.statusCode, 401, 'senha errada continua sendo 401 genérico');
        assert.equal(res.corpo?.error, 'invalid_credentials');

        const acoes = chamadas.map(c => c.acao);
        assert.ok(acoes.includes('record'),
            `a falha precisa ser gravada na camada durável — ações vistas: ${JSON.stringify(acoes)}`);
    });

    it('o identificador enviado ao banco é o HASH, nunca o e-mail em claro', async () => {
        respostaDaEdge = { ok: true, is_locked: false };
        await login({ captchaToken: 'x'.repeat(40) });

        assert.ok(chamadas.length > 0, 'a edge precisa ter sido chamada');
        for (const c of chamadas) {
            assert.match(c.id, /^[0-9a-f]{32}$/, 'identificador fora do formato de hash');
            assert.doesNotMatch(c.id, /@/, 'e-mail em claro vazou para a camada durável');
        }
    });
});

describe('ACHADO-02 — redisDegradado() responde à pergunta certa', () => {
    it('sem Upstash configurado, toda leitura do Redis é indigna de confiança', async () => {
        const { redisDegradado } = await import('../../api/_rate-limit.js');
        // Não é "o Redis está lento" — é "a resposta que acabei de receber saiu
        // do Map local desta instância e um atacante a contorna trocando de
        // instância". Sem Upstash, isso vale sempre.
        assert.equal(redisDegradado(), true);
    });
});
