/**
 * Auditoria de segurança 2026-08-11 — testes de regressão.
 *
 * Um teste por achado corrigido. Cada um FALHA no código de antes da correção
 * e PASSA no de depois — é esse o contrato; um teste que passaria dos dois
 * lados não estaria trancando nada.
 *
 * Onde dá, o teste é COMPORTAMENTAL: extrai as funções reais do arquivo e as
 * executa. Isso importa aqui mais que o normal, porque três dos achados são
 * sobre o que acontece quando alguém MEXE no dado (cookie forjado, URL
 * relativa-de-protocolo) — coisa que asserção sobre texto não observa.
 *
 * Onde a extração não vale a pena, a asserção é sobre o FONTE, e aí valem as
 * duas regras aprendidas na marra:
 *   1. peneirar comentário antes de casar (senão o próprio comentário que
 *      explica a correção faz o teste passar);
 *   2. não usar identificador que aparece na definição E no uso.
 *
 * Puro, sem rede/DOM. Roda no CI: npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

/**
 * Remove comentários SEM tocar em código.
 *
 * Line-based de propósito: um strip por regex de `//.*` engoliria o `//` de
 * `https://…` dentro de string e mutilaria o código que queremos inspecionar.
 * O estilo deste repositório põe comentário em linha própria, então derrubar a
 * linha inteira quando ela COMEÇA com `//`, `/*` ou `*` cobre o caso real.
 */
function semComentarios(src) {
    return src
        .split('\n')
        .filter((l) => {
            const t = l.trim()
            return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
        })
        .join('\n')
}

const AUTH_SESSION = ler('api', 'auth-session.js')
const RATE_LIMIT   = ler('api', '_rate-limit.js')
const AUTH_GUARD   = ler('src', 'scripts', 'modules', 'auth-guard.js')
const BACKUP_EF    = ler('supabase', 'functions', 'user-data-backup', 'index.ts')
const MIGRACAO     = ler('supabase', 'migrations', '20260811000000_revoke_purge_definer_publico.sql')

const AUTH_SESSION_LIMPO = semComentarios(AUTH_SESSION)
const RATE_LIMIT_LIMPO   = semComentarios(RATE_LIMIT)
const AUTH_GUARD_LIMPO   = semComentarios(AUTH_GUARD)
const BACKUP_EF_LIMPO    = semComentarios(BACKUP_EF)

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-002] O cookie ge_mfa é estado do CLIENTE. Sem assinatura, as duas travas
// do 2º fator (5 tentativas e 5 minutos) eram do atacante, não nossas.
//
// Extrai as funções reais do api/auth-session.js e as executa. É o único jeito
// de provar que um payload adulterado é RECUSADO — não existe asserção sobre
// texto que demonstre isso.
// ─────────────────────────────────────────────────────────────────────────────
function carregarCookieMfa() {
    const ini = AUTH_SESSION.indexOf('const MFA_COOKIE_KEY')
    const fim = AUTH_SESSION.indexOf('const mfaTriesKey')
    assert.ok(ini !== -1, 'MFA_COOKIE_KEY sumiu do api/auth-session.js')
    assert.ok(fim > ini,  'mfaTriesKey sumiu do api/auth-session.js')

    const constantes = [
        "const COOKIE_PATH = '/api/auth-session';",
        "const MFA_COOKIE_NAME = 'ge_mfa';",
        'const MFA_TTL_SECS = 300;',
    ].join('\n')

    const corpo = AUTH_SESSION.slice(ini, fim)
    const fab = new Function(
        'createHash', 'createHmac', 'timingSafeEqual', 'Buffer',
        `${constantes}\n${corpo}\nreturn { buildMfaCookie, readMfaCookie, mfaSign };`,
    )
    return fab(createHash, createHmac, timingSafeEqual, Buffer)
}

// A chave deriva do PROXY_SECRET. Qualquer valor serve: assinamos e conferimos
// com o mesmo. O que importa é ele EXISTIR antes de o módulo ser avaliado.
process.env.PROXY_SECRET = process.env.PROXY_SECRET || 'segredo-de-teste-nao-usado-em-lugar-nenhum'

const { buildMfaCookie, readMfaCookie } = carregarCookieMfa()

/** Extrai só o valor do cookie de um header Set-Cookie. */
const valorDoCookie = (setCookie) => setCookie.split(';')[0].slice('ge_mfa='.length)

/** Monta um payload legítimo de desafio em trânsito. */
const payloadValido = (extra = {}) => ({
    at:  'aal1.access.token',
    rt:  'aal1-refresh-token',
    fid: 'fator-totp-123',
    remember: false,
    sid: 'sid-aleatorio-de-16-ou-mais',
    exp: Date.now() + 300_000,
    ...extra,
})

describe('[SEC-002] integridade do cookie ge_mfa', () => {
    test('round-trip: o que assinamos volta a ser lido', () => {
        const p = payloadValido()
        const lido = readMfaCookie(buildMfaCookie(p))
        assert.ok(lido, 'cookie legítimo foi recusado — a correção quebrou o login com 2FA')
        assert.equal(lido.fid, p.fid)
        assert.equal(lido.sid, p.sid)
    })

    test('esticar o `exp` invalida o cookie', () => {
        // ESTE é o ataque. Antes, `exp` era um número dentro de um JSON que o
        // atacante devolve; bastava aumentá-lo para a janela de 5 minutos
        // deixar de existir. Ele tem a senha da vítima e está preso no 2º
        // fator — tempo é exatamente o recurso que ele quer.
        const cru = valorDoCookie(buildMfaCookie(payloadValido()))
        const [b64] = cru.split('.')
        const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
        p.exp = Date.now() + 86_400_000              // de 5 min para 24 h
        const forjado = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')

        // Reaproveita a assinatura original — é tudo que o atacante tem.
        const sigOriginal = cru.split('.')[1]
        assert.equal(readMfaCookie(`ge_mfa=${forjado}.${sigOriginal}`), null)
    })

    test('trocar o `sid` invalida o cookie', () => {
        // O `sid` é o que amarra o desafio ao contador de tentativas do
        // servidor. Se desse para trocá-lo por um sid virgem, o contador
        // externo não valeria nada — cada palpite começaria do zero.
        const cru = valorDoCookie(buildMfaCookie(payloadValido()))
        const [b64, sig] = cru.split('.')
        const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
        p.sid = 'sid-novinho-em-folha-do-atacante'
        const forjado = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')
        assert.equal(readMfaCookie(`ge_mfa=${forjado}.${sig}`), null)
    })

    test('o formato ANTIGO (base64 sem assinatura) é recusado', () => {
        // Regressão direta: este era o cookie do código de antes. Se ele
        // voltasse a ser aceito, a correção inteira estaria contornada por
        // quem simplesmente omitisse a assinatura.
        const cru = Buffer.from(JSON.stringify(payloadValido()), 'utf8').toString('base64url')
        assert.equal(readMfaCookie(`ge_mfa=${cru}`), null)
    })

    test('payload sem `sid` é recusado, mesmo bem assinado', () => {
        const p = payloadValido()
        delete p.sid
        assert.equal(readMfaCookie(buildMfaCookie(p)), null)
    })

    test('`exp` no passado continua sendo recusado', () => {
        // A assinatura não substitui a expiração: ela só impede que a
        // expiração seja reescrita.
        const p = payloadValido({ exp: Date.now() - 1_000 })
        assert.equal(readMfaCookie(buildMfaCookie(p)), null)
    })

    test('o contador de tentativas NÃO viaja mais no cookie', () => {
        // Se `tries` voltar para dentro do payload, volta a ser do cliente —
        // ainda que assinado, ele poderia REPETIR um cookie antigo com
        // tries=0. Assinatura resolve adulteração, não repetição; por isso o
        // contador precisa morar no servidor.
        assert.doesNotMatch(AUTH_SESSION_LIMPO, /buildMfaCookie\(\s*\{\s*\.\.\.pend\s*,\s*tries/)
        assert.doesNotMatch(AUTH_SESSION_LIMPO, /const tries = \(pend\.tries/)
    })

    test('as tentativas são contadas no servidor, com TTL igual ao do desafio', () => {
        assert.match(AUTH_SESSION_LIMPO, /bumpCounter\(mfaTriesKey\(pend\.sid\), MFA_TTL_SECS\)/)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-003] verify-password e mfa-disable fazem password grant de verdade.
// Sem o lockout POR CONTA, eram dois oráculos de senha que o S-2 não via.
// ─────────────────────────────────────────────────────────────────────────────
describe('[SEC-003] os caminhos de senha entram no lockout por conta', () => {
    /** Recorta o bloco de uma `action` até o começo da próxima. */
    function bloco(marcador) {
        const i = AUTH_SESSION_LIMPO.indexOf(marcador)
        assert.ok(i !== -1, `bloco não encontrado: ${marcador}`)
        const resto = AUTH_SESSION_LIMPO.slice(i + marcador.length)
        const j = resto.indexOf("if (action ===")
        return resto.slice(0, j === -1 ? undefined : j)
    }

    for (const [nome, marcador, chave] of [
        ['verify-password', "if (action === 'verify-password')", 'kLockSU'],
        ['mfa-disable',     "if (action === 'mfa-disable')",     'kLockMD'],
    ]) {
        test(`${nome}: recusa quando a conta está travada`, () => {
            assert.match(bloco(marcador), new RegExp(`isKeyBlocked\\(${chave}\\)`))
        })

        test(`${nome}: senha errada escalona o mesmo contador do login`, () => {
            const b = bloco(marcador)
            // `loginfail:` e `loginlock:` são os prefixos que o /login já usa.
            // Ter de somar no MESMO balde é o ponto: um atacante que alterne
            // entre os endpoints não pode ganhar um orçamento novo em cada um.
            assert.match(b, /loginfail:/)
            assert.match(b, /loginlock:/)
            assert.match(b, /bumpCounter\(kFail(SU|MD), LOCK_JANELA\)/)
            assert.match(b, /LOCK_DEGRAUS\.find/)
        })

        test(`${nome}: senha certa zera o histórico`, () => {
            assert.match(bloco(marcador), /clearKeys\(kFail(SU|MD), kLock(SU|MD)\)/)
        })
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-004] O gate de 2FA existia em get/save-user-data e faltava aqui — na
// única outra edge que ESCREVE no mesmo blob com o mesmo service_role.
// ─────────────────────────────────────────────────────────────────────────────
describe('[SEC-004] gate de 2FA no user-data-backup', () => {
    test('importa o gate compartilhado (não uma cópia local)', () => {
        assert.match(BACKUP_EF_LIMPO, /import \{ mfaBloqueia \} from '\.\.\/_shared\/mfa-gate\.ts'/)
    })

    test('chama o gate e responde 403 quando a sessão não está elevada', () => {
        assert.match(BACKUP_EF_LIMPO, /if \(await mfaBloqueia\(admin, token, user\.id, 'user-data-backup'\)\)/)
        assert.match(BACKUP_EF_LIMPO, /mfa_required: true \}, 403/)
    })

    test('o gate roda ANTES de listar snapshot ou restaurar', () => {
        // Ordem é o que faz o gate valer. Depois do GET, ele só decoraria: as
        // datas de snapshot já teriam saído, e é delas que o atacante precisa
        // para escolher a reversão mais cara.
        const iGate    = BACKUP_EF_LIMPO.indexOf('mfaBloqueia(admin')
        const iListar  = BACKUP_EF_LIMPO.indexOf("from('user_data_snapshots')")
        const iEscrita = BACKUP_EF_LIMPO.indexOf("from('user_data')")
        assert.ok(iGate !== -1 && iListar !== -1 && iEscrita !== -1)
        assert.ok(iGate < iListar,  'o gate ficou DEPOIS da listagem de snapshots')
        assert.ok(iGate < iEscrita, 'o gate ficou DEPOIS da escrita em user_data')
    })

    test('as três edges que falam com user_data via service_role têm o gate', () => {
        // Varredura, não lista fixa: o buraco nasceu de uma edge nova que
        // esqueceu o gate. Se surgir uma quarta, este teste é quem avisa.
        for (const ef of ['get-user-data', 'save-user-data', 'user-data-backup']) {
            const src = semComentarios(ler('supabase', 'functions', ef, 'index.ts'))
            assert.match(src, /mfaBloqueia\(/, `${ef} não aplica o gate de 2FA`)
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-005] O IP ia CRU no caminho da URL do Upstash — e o caminho é o que
// escolhe o comando do Redis.
// ─────────────────────────────────────────────────────────────────────────────
describe('[SEC-005] nenhuma chave do Redis viaja no CAMINHO da URL', () => {
    // A primeira versão desta correção só codificava a chave no path. Ela tapava
    // o buraco e abria outro, silencioso: as ESCRITAS mandam a chave pelo
    // pipeline, LITERAL, e todas as chaves têm `:` (`blocklist:ip:…`,
    // `loginlock:…`). Codificar só na leitura faria os dois lados mirarem chaves
    // diferentes — blocklist e lockout de conta respondendo "livre" para sempre.
    // A correção final tira a chave do path: pipeline dos dois lados.

    test('as três leituras usam o pipeline, não o path', () => {
        for (const [fn, cmd] of [
            ['isIPBlocked',   'EXISTS'],
            ['readCounter',   'GET'],
            ['isKeyBlocked',  'EXISTS'],
        ]) {
            const i = RATE_LIMIT_LIMPO.indexOf(`export async function ${fn}`)
            assert.ok(i !== -1, `${fn} sumiu do módulo`)
            const corpo = RATE_LIMIT_LIMPO.slice(i, i + 900)
            assert.match(corpo, new RegExp(`_redisCmd\\('${cmd}'`),
                `${fn} não usa o pipeline`)
            assert.doesNotMatch(corpo, /REDIS_URL\}\/(?:exists|get|del)\//,
                `${fn} ainda monta comando pelo path da URL`)
        }
    })

    test('leitura e escrita da MESMA chave usam o mesmo caminho', () => {
        // O defeito não era codificar demais nem de menos — era assimetria.
        // blockIP grava por pipeline; isIPBlocked tem de ler por pipeline.
        for (const fn of ['blockIP', 'blockKey', 'bumpCounter', 'clearKeys']) {
            const i = RATE_LIMIT_LIMPO.indexOf(`export async function ${fn}`)
            if (i === -1) continue
            assert.match(RATE_LIMIT_LIMPO.slice(i, i + 900), /REDIS_URL\}\/pipeline/,
                `${fn} deixou de usar o pipeline — a simetria com a leitura quebrou`)
        }
    })

    test('VARREDURA: nenhuma interpolação não-constante em path do Upstash', () => {
        // Cobre api/ inteiro, não só o _rate-limit: o mesmo padrão estava em
        // api/user-data.js (`/del/gd:${userId}`, com userId vindo de um JWT
        // decodificado SEM verificar assinatura).
        const cruas = []
        for (const [nome, src] of [
            ['api/_rate-limit.js', RATE_LIMIT_LIMPO],
            ['api/user-data.js',   semComentarios(ler('api', 'user-data.js'))],
            ['api/_alert.js',      semComentarios(ler('api', '_alert.js'))],
        ]) {
            for (const m of src.matchAll(/REDIS_URL\}\/(?!pipeline)[a-z]+\/[^`]*?\$\{([^}]+)\}/g)) {
                const expr = m[1].trim()
                const constante = /^[A-Z_][A-Z0-9_]*$/.test(expr)      // DEAD_LETTER_KEY
                const encodada  = expr.includes('encodeURIComponent')
                if (!constante && !encodada) cruas.push(`${nome}: \${${expr}}`)
            }
        }
        assert.deepEqual(cruas, [], `chave crua em path do Upstash: ${cruas.join(' | ')}`)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-006] SafeRedirect tratava `//evil.com` como caminho relativo.
// Teste comportamental: extrai o predicado real e o executa.
// ─────────────────────────────────────────────────────────────────────────────
function carregarIsSafe() {
    const ini = AUTH_GUARD.indexOf('    _isSafe(url) {')
    assert.ok(ini !== -1, '_isSafe sumiu do auth-guard.js')
    const fim = AUTH_GUARD.indexOf('\n    },', ini)
    assert.ok(fim > ini, 'não achei o fim do _isSafe')
    const corpo = AUTH_GUARD.slice(ini, fim + 6)

    const fab = new Function('SECURITY', 'window', 'console', `
        const obj = { ${corpo} };
        return (u) => obj._isSafe(u);
    `)
    return fab(
        { DANGEROUS_SCHEMES: ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'] },
        { location: { origin: 'https://www.granaevo.com' } },
        { error() {} },
    )
}

const ehSeguro = carregarIsSafe()

describe('[SEC-006] SafeRedirect e a URL relativa-de-protocolo', () => {
    test('caminhos internos continuam aceitos', () => {
        // Se isto quebrar, a correção derrubou os redirects legítimos — que é
        // o jeito mais fácil de "consertar" segurança quebrando o produto.
        for (const u of ['dashboard.html', '/planos', 'planos.html?retomar=1', 'login.html?c=e0']) {
            assert.equal(ehSeguro(u), true, `deveria aceitar: ${u}`)
        }
    })

    test('same-origin absoluto continua aceito', () => {
        assert.equal(ehSeguro('https://www.granaevo.com/dashboard'), true)
    })

    test('externo absoluto continua recusado', () => {
        assert.equal(ehSeguro('https://evil.com/'), false)
    })

    test('`//evil.com` é recusado', () => {
        // O caso do achado: não começa com http:// nem https://, então caía no
        // "é relativo, pode passar" — e o browser resolve para https://evil.com.
        assert.equal(ehSeguro('//evil.com'), false)
        assert.equal(ehSeguro('//evil.com/dashboard.html'), false)
    })

    test('contrabarra e espaço à frente não contornam a checagem', () => {
        for (const u of ['\\\\evil.com', '/\\evil.com', '  //evil.com', '\t//evil.com']) {
            assert.equal(ehSeguro(u), false, `deveria recusar: ${u}`)
        }
    })

    test('esquemas perigosos seguem bloqueados', () => {
        for (const u of ['javascript:alert(1)', 'data:text/html,<script>', 'blob:https://x']) {
            assert.equal(ehSeguro(u), false, `deveria recusar: ${u}`)
        }
    })

    test('VARREDURA: TODA cópia de _isSafe no projeto recusa `//`', () => {
        // O SEC-006 voltou na 3ª rodada porque `convidados.js` tinha uma SEGUNDA
        // cópia do mesmo predicado, byte-idêntica à versão vulnerável. Corrigir
        // uma primitiva duplicada corrige UMA das cópias — e nada avisa sobre a
        // outra. Esta varredura é o aviso.
        const alvos = []
        const anda = (dir) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name)
                if (e.isDirectory()) anda(p)
                else if (e.name.endsWith('.js')) {
                    const s = readFileSync(p, 'utf8')
                    if (s.includes('_isSafe(url)')) alvos.push([p, s])
                }
            }
        }
        anda(join(RAIZ, 'src', 'scripts'))

        assert.ok(alvos.length >= 2,
            `esperava ao menos 2 cópias de _isSafe (auth-guard e convidados), achei ${alvos.length}`)

        for (const [p, s] of alvos) {
            const ini = s.indexOf('_isSafe(url) {')
            const fim = s.indexOf('\n    },', ini)
            const corpo = s.slice(ini, fim > ini ? fim + 6 : ini + 2000)
            // As duas cópias leem a lista de esquemas de lugares diferentes:
            // auth-guard usa a constante de módulo `SECURITY.DANGEROUS_SCHEMES`,
            // convidados usa `this._DANGEROUS_SCHEMES`. O harness fornece as
            // duas formas — a divergência é justamente o que estamos medindo.
            const fab = new Function('SECURITY', 'window', 'console', `
                const obj = {
                    _DANGEROUS_SCHEMES: SECURITY.DANGEROUS_SCHEMES,
                    ${corpo}
                };
                return (u) => obj._isSafe(u);
            `)
            const seguro = fab(
                { DANGEROUS_SCHEMES: ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'] },
                { location: { origin: 'https://www.granaevo.com' } },
                { error() {} },
            )
            for (const mau of ['//evil.com', '  //evil.com', 'javascript:alert(1)']) {
                assert.equal(seguro(mau), false, `${p} aceita ${JSON.stringify(mau)}`)
            }
            // E não pode ter quebrado o caminho legítimo.
            assert.equal(seguro('login.html'), true, `${p} recusa caminho interno`)
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-001] As duas SECURITY DEFINER que o `anon` podia executar.
// O banco é a autoridade; aqui trancamos a MIGRATION, para que ela não seja
// editada sem a varredura que impede o buraco de renascer.
// ─────────────────────────────────────────────────────────────────────────────
describe('[SEC-001] migration que fecha o EXECUTE público', () => {
    test('revoga as duas funções de PUBLIC e dos papéis do PostgREST', () => {
        for (const fn of ['purge_guest_invitations', 'purge_profile_backups_terminal']) {
            assert.match(MIGRACAO, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(\\)\\s+FROM PUBLIC`))
            assert.match(MIGRACAO, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(\\)\\s+FROM anon, authenticated`))
        }
    })

    test('tem varredura que reprova se outra DEFINER ficar exposta', () => {
        // `CREATE FUNCTION` concede EXECUTE a PUBLIC por padrão: sem esta
        // varredura, o buraco se reabre sozinho na próxima função nova em que
        // alguém esquecer o REVOKE.
        assert.match(MIGRACAO, /has_function_privilege\('anon',\s+p\.oid, 'EXECUTE'\)/)
        assert.match(MIGRACAO, /has_function_privilege\('authenticated',\s+p\.oid, 'EXECUTE'\)/)
        assert.match(MIGRACAO, /RAISE EXCEPTION/)
    })

    test('a allow-list tem só as duas funções usadas dentro de policies', () => {
        // can_create_profile() está no WITH CHECK de profiles_insert_own e
        // mfa_pendente() nas policies `exige_aal2`: o papel que dispara a query
        // precisa poder avaliá-las. Qualquer nome a mais aqui é uma exceção que
        // alguém abriu, e tem de doer.
        const m = MIGRACAO.match(/p\.proname NOT IN \(([^)]*)\)/)
        assert.ok(m, 'allow-list não encontrada na varredura')
        assert.equal(m[1].trim(), "'can_create_profile', 'mfa_pendente'")
    })

    test('existe o rollback correspondente', () => {
        const down = ler('supabase', 'rollbacks', '20260811000000_revoke_purge_definer_publico.down.sql')
        assert.match(down, /GRANT EXECUTE ON FUNCTION public\.purge_guest_invitations\(\)\s+TO PUBLIC/)
        assert.match(down, /GRANT EXECUTE ON FUNCTION public\.purge_profile_backups_terminal\(\)\s+TO PUBLIC/)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-009] O cliente tinha ESCRITA direta em user_data por PostgREST — o
// caminho que pula a guarda anti-wipe, a trava de versão, o merge por perfil, o
// gate de 2FA e a cifragem.
// ─────────────────────────────────────────────────────────────────────────────
const MIG_USERDATA = ler('supabase', 'migrations', '20260811020000_user_data_sem_escrita_do_cliente.sql')

describe('[SEC-009] user_data não é escrita pelo cliente', () => {
    test('a migration revoga INSERT/UPDATE/DELETE de authenticated', () => {
        assert.match(MIG_USERDATA,
            /REVOKE INSERT, UPDATE, DELETE ON public\.user_data FROM authenticated/)
    })

    test('mantém o SELECT — revogar junto mataria a policy user_data_select', () => {
        assert.doesNotMatch(MIG_USERDATA, /REVOKE[^;]*SELECT[^;]*user_data/)
        assert.match(MIG_USERDATA, /NOT has_table_privilege\('authenticated', 'public\.user_data', 'SELECT'\)/)
    })

    test('a migration se autoverifica', () => {
        assert.match(MIG_USERDATA, /RAISE EXCEPTION 'REVOKE nao pegou/)
    })

    test('INVARIANTE: nenhum código de cliente escreve user_data por PostgREST', () => {
        // O REVOKE só é seguro enquanto isto for verdade. Se alguém amanhã
        // escrever `.from('user_data').update(...)` no cliente, a feature vai
        // falhar com "permission denied" e ninguém vai lembrar por quê. Este
        // teste falha ANTES, no CI, com a explicação junto.
        const ofensores = []
        const anda = (dir) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name)
                if (e.isDirectory()) { anda(p); continue }
                if (!/\.(js|html)$/.test(e.name)) continue
                const s = readFileSync(p, 'utf8')
                if (/from\(['"]user_data['"]\)|rest\/v1\/user_data/.test(s)) ofensores.push(p)
            }
        }
        anda(join(RAIZ, 'src'))
        anda(join(RAIZ, 'public'))
        assert.deepEqual(ofensores, [],
            'cliente acessa user_data por PostgREST — o REVOKE do SEC-009 vai quebrá-lo. '
            + 'Todo save passa por /api/user-data → save-user-data. Ofensores: ' + ofensores.join(', '))
    })

    test('existe o rollback correspondente', () => {
        const down = ler('supabase', 'rollbacks', '20260811020000_user_data_sem_escrita_do_cliente.down.sql')
        assert.match(down, /GRANT INSERT, UPDATE, DELETE ON public\.user_data TO authenticated/)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// [SEC-008] Trocar a senha não expulsava ninguém.
//
// Achado na SEGUNDA passada. O `delete-account` revogava sessões desde sempre;
// o reset de senha, não — e é ele que a vítima usa quando desconfia que a conta
// foi invadida.
// ─────────────────────────────────────────────────────────────────────────────
const RESET_EF       = ler('supabase', 'functions', 'verify-and-reset-password', 'index.ts')
const RESET_EF_LIMPO = semComentarios(RESET_EF)
const MIG_SESSOES    = ler('supabase', 'migrations', '20260811010000_revogar_sessoes_no_reset.sql')

describe('[SEC-008] o reset de senha encerra as sessões antigas', () => {
    test('a edge chama a RPC de revogação', () => {
        assert.match(RESET_EF_LIMPO, /\.rpc\('revogar_sessoes_usuario', \{ p_user_id: userIdParaRevogar \}\)/)
    })

    test('revoga DEPOIS de a senha ter sido trocada', () => {
        // Ordem importa nos dois sentidos: revogar antes deixaria a sessão do
        // invasor voltar a valer se a troca falhasse logo em seguida.
        const iTroca  = RESET_EF_LIMPO.indexOf('updateResult.ok')
        const iRevoga = RESET_EF_LIMPO.indexOf('revogar_sessoes_usuario')
        assert.ok(iTroca !== -1 && iRevoga !== -1)
        assert.ok(iRevoga > iTroca, 'a revogação ficou ANTES da troca de senha')
    })

    test('é best-effort — nunca transforma um reset bem-sucedido em erro', () => {
        // A senha JÁ mudou quando isto roda. Responder erro faria o usuário
        // tentar de novo com a senha antiga, que não vale mais.
        const i = RESET_EF_LIMPO.indexOf('revogar_sessoes_usuario')
        const bloco = RESET_EF_LIMPO.slice(i - 400, i + 700)
        assert.doesNotMatch(bloco, /return json\(\{ status: 'error'/)
        assert.match(bloco, /console\.error/)
    })

    test('resolve o user_id pelo e-mail quando a linha legada não tem', () => {
        assert.match(RESET_EF_LIMPO, /get_auth_user_id_by_email/)
    })

    test('a migration NÃO deixa a RPC executável por anon/authenticated', () => {
        // Sem isto, a correção seria pior que o defeito: logout forçado de
        // qualquer conta, sem login, sabendo só o uuid.
        assert.match(MIG_SESSOES, /REVOKE EXECUTE ON FUNCTION public\.revogar_sessoes_usuario\(uuid\) FROM PUBLIC/)
        assert.match(MIG_SESSOES, /REVOKE EXECUTE ON FUNCTION public\.revogar_sessoes_usuario\(uuid\) FROM anon, authenticated/)
        assert.match(MIG_SESSOES, /GRANT  EXECUTE ON FUNCTION public\.revogar_sessoes_usuario\(uuid\) TO service_role/)
    })

    test('a RPC é SECURITY DEFINER com search_path vazio', () => {
        // Roda como `postgres` e mexe no schema auth: search_path herdado do
        // chamador seria escalada de privilégio.
        assert.match(MIG_SESSOES, /SECURITY DEFINER\s+SET search_path = ''/)
        assert.match(MIG_SESSOES, /DELETE FROM auth\.sessions WHERE user_id = p_user_id/)
    })

    test('a migration se autoverifica em vez de confiar na anterior', () => {
        assert.match(MIG_SESSOES, /has_function_privilege\('anon',\s+p\.oid, 'EXECUTE'\)/)
        assert.match(MIG_SESSOES, /RAISE EXCEPTION/)
    })

    test('existe o rollback correspondente', () => {
        const down = ler('supabase', 'rollbacks', '20260811010000_revogar_sessoes_no_reset.down.sql')
        assert.match(down, /DROP FUNCTION IF EXISTS public\.revogar_sessoes_usuario\(uuid\)/)
    })

    test('VARREDURA: todo caminho que troca senha ou apaga conta revoga sessão', () => {
        // Item 11 do escopo, virado teste permanente. O SEC-008 nasceu porque a
        // defesa existia em UM dos dois lugares. Se aparecer um terceiro
        // caminho que mexe em credencial, é aqui que ele é pego.
        const revoga = (s) => /admin\.signOut\(|revogar_sessoes_usuario/.test(s)
        const mexeEmCredencial = (s) =>
            /updateUserById\([^)]*,\s*\{\s*password/.test(s) || /admin\.deleteUser\(/.test(s)

        // Allow-list com MOTIVO, não regex esperta. Uma regex que tentasse
        // distinguir "delete de rollback" de "delete de verdade" seria frágil e
        // ninguém saberia o que ela decidiu; um nome numa lista com o porquê ao
        // lado é auditável na revisão.
        //
        //   verify-guest-invite: o `admin.deleteUser` é ROLLBACK de uma conta
        //   criada segundos antes, quando o INSERT em account_members falha.
        //   Uma conta que nunca fez login não tem sessão para encerrar.
        //   (Conferido em 2026-08-11: é a única chamada de deleteUser do arquivo,
        //   e está dentro do `if (memberError)`.)
        const DISPENSADAS = new Set(['verify-guest-invite'])

        const base = join(RAIZ, 'supabase', 'functions')
        const fns  = readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== '_shared')
            .map((d) => d.name)

        const faltando = []
        for (const fn of fns) {
            if (DISPENSADAS.has(fn)) continue
            const p = join(base, fn, 'index.ts')
            if (!existsSync(p)) continue
            const src = semComentarios(readFileSync(p, 'utf8'))
            if (mexeEmCredencial(src) && !revoga(src)) faltando.push(fn)
        }
        assert.deepEqual(faltando, [],
            `edge muda credencial e NÃO revoga sessão: ${faltando.join(', ')}`)
    })
})
