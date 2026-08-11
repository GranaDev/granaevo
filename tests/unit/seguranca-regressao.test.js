/**
 * GranaEvo — Testes de regressão de segurança (B-7)
 *
 * REGRA 9 do /god-mode: todo vetor fechado vira teste. Este arquivo trava as
 * correções da auditoria de 2026-07-27 para que nenhuma volte em silêncio numa
 * refatoração futura.
 *
 * São testes de INVARIANTE DE ARQUITETURA sobre o código-fonte e as migrations,
 * não testes de integração. É de propósito: rodam no CI sem banco, sem rede e
 * sem segredo, e pegam justamente o tipo de erro que causou cada achado — uma
 * palavra trocada num trigger, um GRANT esquecido, um import removido.
 *
 * Cada teste diz O QUE quebrou quando falhar, não só "assertion failed".
 *
 *   node --test tests/unit/
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

/** Concatena todas as migrations UP (ignora .down.sql). */
function todasAsMigrations() {
  const dir = join(RAIZ, 'supabase', 'migrations')
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .map(f => ler('supabase', 'migrations', f))
    .join('\n')
}

/**
 * assert.match() sobre o corpo das migrations despeja os ~160 KB de SQL no
 * output quando falha, e a mensagem útil se perde no meio. Aqui o resultado é
 * reduzido a um booleano ANTES da asserção, então o CI mostra só o porquê.
 */
function contemNasMigrations(regex, mensagem) {
  assert.ok(regex.test(todasAsMigrations()), mensagem)
}

// ═══════════════════════════════════════════════════════════════════════════
describe('S-1 — limite de perfis não pode voltar a ser burlável por lote', () => {
  const mig = ler('supabase', 'migrations', '20260727010000_fix_profile_limit_batch_bypass.sql')

  test('o trigger é CONSTRAINT TRIGGER AFTER INSERT, nunca BEFORE', () => {
    assert.match(mig, /CREATE CONSTRAINT TRIGGER enforce_profile_limit_stripe/i,
      'O trigger precisa ser CONSTRAINT TRIGGER: em BEFORE ROW, a query dentro dele '
      + 'NÃO enxerga as linhas do próprio comando, e um INSERT com array JSON cria '
      + 'N perfis num plano de 1.')
    assert.match(mig, /AFTER INSERT ON public\.profiles/i,
      'Voltar para BEFORE INSERT reabre o bypass em lote (achado S-1).')
    assert.doesNotMatch(mig, /BEFORE INSERT ON public\.profiles/i,
      'BEFORE INSERT em profiles é exatamente a falha que esta migration corrigiu.')
  })

  test('a comparação é `>` — com `>=` em AFTER, ninguém cria o primeiro perfil', () => {
    assert.match(mig, /IF\s+v_count\s*>\s*v_max\s+THEN/i,
      'Em AFTER a contagem JÁ INCLUI a linha inserida. Com `>=`, um usuário do plano '
      + 'Individual (máx. 1) com 0 perfis insere 1, conta 1, e `1 >= 1` bloqueia o '
      + 'PRIMEIRO perfil dele. As duas coisas (timing e comparação) andam em par.')
    assert.doesNotMatch(mig, /IF\s+v_count\s*>=\s*v_max\s+THEN/i,
      '`>=` só é correto em BEFORE. Ver o aviso no cabeçalho da migration.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A-2 — o X da caixa de entrada do sino precisa continuar funcionando', () => {
  test('existe GRANT UPDATE (dismissed_at) e ele é POR COLUNA', () => {
    contemNasMigrations(/GRANT\s+UPDATE\s*\(\s*dismissed_at\s*\)\s+ON\s+public\.radar_notifications/i,
      'A policy radar_update_own_dismiss existe desde 20260726000000, mas o GRANT foi '
      + 'esquecido — o botão de dispensar ficou morto em produção, engolindo o 42501 '
      + 'em silêncio. O grant é POR COLUNA de propósito: mesmo que o trigger de '
      + 'congelamento seja removido, só dismissed_at fica escrevível.')
  })

  test('o cliente ainda dispensa via UPDATE em dismissed_at', () => {
    const js = ler('src', 'scripts', 'modules', 'notificacoes-inbox.js')
    assert.match(js, /\.update\(\s*\{\s*dismissed_at/,
      'Se o cliente mudar de UPDATE para DELETE, o grant acima vira cruft e a '
      + 'notificação some do histórico em vez de ser marcada como lida.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-1 — 2FA: o refresh token elevado nunca pode chegar ao JavaScript', () => {
  const bff = ler('api', 'auth-session.js')

  test('o BFF devolve apenas o access token ao cliente', () => {
    const payload = bff.match(/function sessionPayload\(grant\)\s*\{[\s\S]*?\n\}/)
    assert.ok(payload, 'sessionPayload() sumiu — era ela que filtrava o que vai ao cliente.')
    assert.doesNotMatch(payload[0], /refresh_token/,
      'sessionPayload NUNCA pode incluir refresh_token: ele vive só no cookie HttpOnly. '
      + 'É a razão de existir de todo o modelo híbrido.')
  })

  test('o cliente não usa supabase.auth.mfa.* (o verify devolve refresh novo)', () => {
    for (const arq of [['src','scripts','services','mfa-api.js'],
                       ['src','scripts','modules','security-panel.js'],
                       ['src','scripts','pages','login.js']]) {
      assert.doesNotMatch(ler(...arq), /auth\.mfa\.(enroll|challenge|verify|unenroll)/,
        `${arq.join('/')} não pode falar com o GoTrue direto: mfa.verify() devolve um `
        + 'par access+refresh NOVO, e o refresh cairia no JS. Tudo passa pelo BFF.')
    }
  })

  test('o cookie da sessão em trânsito é HttpOnly, Secure e SameSite=Strict', () => {
    const fn = bff.match(/function buildMfaCookie\([\s\S]*?\n\}/)
    assert.ok(fn, 'buildMfaCookie() sumiu.')
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) {
      assert.match(fn[0], new RegExp(flag),
        `ge_mfa sem ${flag}: entre "senha certa" e "código certo" existe uma sessão aal1 `
        + 'válida. Se ela vazar para o JS, basta a senha e o 2º fator vira teatro.')
    }
  })

  test('o gate do login só considera fator VERIFICADO', () => {
    assert.match(bff, /status\s*===\s*'verified'/,
      'Contar fator `unverified` faria um enroll abandonado barrar o login do próprio dono.')
  })

  test('o login falha FECHADO quando não dá para saber se há 2º fator', () => {
    assert.match(bff, /if\s*\(!fatoresOk\)[\s\S]{0,200}?503/,
      'Se a consulta de fatores falhar, o login tem de recusar. Falhar aberto daria a '
      + 'um atacante com a senha um jeito de pular o 2º fator só provocando o erro.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-1c — as edges de dados bypassam RLS, então precisam do gate próprio', () => {
  for (const edge of ['get-user-data', 'save-user-data']) {
    test(`${edge} chama mfaBloqueia antes de tocar nos dados`, () => {
      const src = ler('supabase', 'functions', edge, 'index.ts')
      assert.match(src, /import\s*\{\s*mfaBloqueia\s*\}\s*from\s*'\.\.\/_shared\/mfa-gate\.ts'/,
        `${edge} usa service_role e BYPASSA RLS — o enforcement de aal2 das policies não `
        + 'chega aqui. Sem este import, o blob financeiro fica acessível em sessão aal1.')
      assert.match(src, /await mfaBloqueia\(/,
        `${edge} importa mas não chama mfaBloqueia — o gate existe e não protege nada.`)
    })
  }

  test('o gate falha FECHADO se a RPC não responder', () => {
    const gate = ler('supabase', 'functions', '_shared', 'mfa-gate.ts')
    const corpo = gate.match(/export async function mfaBloqueia[\s\S]*$/)[0]
    assert.doesNotMatch(corpo, /return false\s*\n\s*\}\s*\n\s*\}\s*$/,
      'Falhar aberto daria ao atacante um jeito de contornar o 2º fator derrubando uma chamada.')
    assert.match(corpo, /catch[\s\S]{0,200}return true/,
      'No catch, mfaBloqueia tem de devolver true (recusar).')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S-2 — lockout de login por conta', () => {
  const bff = ler('api', 'auth-session.js')

  test('a trava é consultada ANTES do password grant', () => {
    const i = bff.indexOf('isKeyBlocked(kLock)')
    const j = bff.indexOf("gotrue('token?grant_type=password'")
    assert.ok(i > -1 && j > -1 && i < j,
      'Uma conta travada não pode nem chegar ao GoTrue.')
  })

  test('a falha é contada mesmo para e-mail inexistente (anti-enumeração)', () => {
    assert.match(bff, /bumpCounter\(kFail/,
      'Contar só para contas reais transformaria o 429 em oráculo: "travou, logo existe".')
  })

  test('o histórico zera no login bem-sucedido', () => {
    assert.match(bff, /clearKeys\(kFail,\s*kLock\)/,
      'Sem isto, falhas legítimas espalhadas num dia somariam até travar quem nunca foi atacado.')
  })

  test('a chave é hash do e-mail, não o e-mail em claro', () => {
    assert.match(bff, /createHash\('sha256'\)\.update\(email\)/,
      'E-mail em claro nas chaves do Redis é PII espalhada sem necessidade.')
  })

  test('o escalonamento é progressivo e começa em minutos, não em dias', () => {
    const m = bff.match(/const LOCK_DEGRAUS = \[[\s\S]*?\]/)
    assert.ok(m, 'LOCK_DEGRAUS sumiu.')
    const ttls = [...m[0].matchAll(/ttl:\s*([\d_]+)/g)].map(x => Number(x[1].replace(/_/g, '')))
    assert.ok(Math.min(...ttls) <= 900,
      'O primeiro degrau tem de ser curto (≤15min): todo lockout por conta permite que um '
      + 'terceiro trave a vítima de propósito, e o preço disso não pode ser um dia fora do ar.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S-3 / S-4 — grants que não podem voltar', () => {
  const sql = todasAsMigrations()

  test('user_data_snapshots não expõe o blob nem o e-mail', () => {
    contemNasMigrations(/REVOKE SELECT ON public\.user_data_snapshots FROM authenticated/i,
      'Sem o REVOKE, authenticated volta a ler data_json (o blob financeiro) via PostgREST.')
    const grant = sql.match(/GRANT\s+SELECT\s*\(([^)]*)\)\s*\n?\s*ON public\.user_data_snapshots/i)
    assert.ok(grant, 'O GRANT por coluna sumiu — sem ele o backup para de listar.')
    for (const proibida of ['data_json', 'user_email']) {
      assert.ok(!grant[1].includes(proibida),
        `${proibida} não pode estar no GRANT: é o blob financeiro / PII em claro.`)
    }
  })

  test('terms_acceptance é imutável para o cliente', () => {
    contemNasMigrations(/REVOKE UPDATE, DELETE ON public\.terms_acceptance FROM authenticated/i,
      'Aceite de termos é a prova do consentimento LGPD; o usuário não reescreve a própria prova.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('S-6 — imutabilidade do audit log', () => {
  test('a exceção exige o GUC E ser postgres', () => {
    const sql = ler('supabase', 'migrations', '20260727040000_seguranca_passo30.sql')
    assert.match(sql, /current_setting\('granaevo\.audit_retention'[\s\S]{0,120}?current_user = 'postgres'/,
      'Só o GUC não basta: GUCs de prefixo customizado são setáveis por qualquer role, '
      + 'então uma Edge com service_role conseguiria zerar o registro financeiro.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M-4 — purgas não podem apagar convidado ativo', () => {
  test('purge_expired_cancelled_accounts tem a guarda de account_members', () => {
    const sql = ler('supabase', 'migrations', '20260727040000_seguranca_passo30.sql')
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.purge_expired_cancelled_accounts[\s\S]*?\$function\$;/)
    assert.ok(fn, 'A função sumiu da migration.')
    assert.match(fn[0], /NOT EXISTS[\s\S]{0,200}account_members[\s\S]{0,200}is_active = true/,
      'Foi o bug de 2026-07-01: os crons apagaram convidados de plano casal/família que '
      + 'não têm assinatura própria. Esta era a única das 3 purgas sem a guarda.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('Assistente — a IA continua sendo função, nunca interlocutor', () => {
  const cp = ler('supabase', 'functions', 'chat-parse', 'index.ts')

  test('tool use é forçado e o schema é estrito', () => {
    assert.match(cp, /tool_choice:\s*\{\s*type:\s*'tool'/,
      'Sem tool_choice forçado, o modelo volta a poder emitir texto livre.')
    assert.match(cp, /strict:\s*true/)
    assert.match(cp, /additionalProperties:\s*false/,
      'É o que torna prompt injection estruturalmente inofensiva: o schema trava a saída.')
  })

  test('nenhum texto do modelo chega ao usuário', () => {
    assert.match(cp, /parse:\s*toolUse\.input/,
      'A resposta devolve só o objeto tipado. Devolver texto do modelo reabriria injeção.')
  })

  test('nenhum valor em R$ é enviado à IA', () => {
    const body = cp.match(/const body = \{[\s\S]*?\n\s*\}/)[0]
    assert.doesNotMatch(body, /saldo|valor_total|transacoes/i,
      'A IA recebe só texto e rótulos. Mandar valores quebraria a promessa central do produto.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('Segredos — nada de service_role no que vai ao browser', () => {
  test('nenhum arquivo de src/ referencia a service_role key', () => {
    const varrer = (dir) => readdirSync(join(RAIZ, dir), { withFileTypes: true })
      .flatMap(d => d.isDirectory() ? varrer(join(dir, d.name))
                  : d.name.endsWith('.js') ? [join(dir, d.name)] : [])
    for (const arq of varrer('src')) {
      const src = readFileSync(join(RAIZ, arq), 'utf8')
        .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
      assert.doesNotMatch(src, /SERVICE_ROLE|service_role_key|sb_secret_/,
        `${arq} referencia a service_role — ela só existe nos secrets do Supabase.`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-4 — todo alerta configurado precisa ter quem o dispare', () => {
  const alert = ler('api', '_alert.js')

  /** Junta o código de todos os lugares que podem emitir evento de segurança. */
  function fontesEmissoras() {
    const arquivos = []
    for (const d of readdirSync(join(RAIZ, 'api'))) {
      if (d.endsWith('.js')) arquivos.push(ler('api', d))
    }
    for (const d of readdirSync(join(RAIZ, 'supabase', 'functions'))) {
      try { arquivos.push(ler('supabase', 'functions', d, 'index.ts')) } catch { /* _shared */ }
    }
    arquivos.push(ler('supabase', 'functions', '_shared', 'sec-report.ts'))
    return arquivos.join('\n')
  }

  test('nenhum threshold fica órfão (era o buraco do B-4)', () => {
    const thresholds = [...alert.matchAll(/^\s{2}([a-z_]+):\s*\{\s*count:/gm)].map(m => m[1])
    assert.ok(thresholds.length >= 5, 'THRESHOLDS encolheu — confira se algum alerta foi removido.')

    const fontes = fontesEmissoras()
    const orfaos = thresholds.filter(t => !fontes.includes(`'${t}'`))
    assert.deepEqual(orfaos, [],
      `Threshold sem emissor: ${orfaos.join(', ')}. Um alerta configurado que ninguém dispara `
      + 'é pior que nenhum alerta: dá a sensação de estar monitorado sem estar. Foi assim que '
      + 'webhook_tamper e proxy_bypass ficaram — definidos e mudos. Ou ligue o emissor, ou '
      + 'remova o threshold.')
  })

  test('o lockout de login (S-2) reporta, não só loga', () => {
    assert.match(ler('api', 'auth-session.js'), /trackSecurityEvent\('login_lockout'/,
      'Um lockout isolado é ruído; vários em minutos é credential stuffing. Sem esta chamada '
      + 'o sinal mais valioso do S-2 morre no log.')
  })

  test('a ponte edge→Vercel tem allow-list de eventos', () => {
    const ud = ler('api', 'user-data.js')
    assert.match(ud, /const PERMITIDOS = new Set\(\[/,
      'Sem allow-list, quem obtivesse o proxy-secret forjaria qualquer evento — inclusive os '
      + 'que BLOQUEIAM IP ao atingir o threshold.')
  })

  test('o reporte da edge é fire-and-forget', () => {
    const sr = ler('supabase', 'functions', '_shared', 'sec-report.ts')
    assert.doesNotMatch(sr, /await fetch\(ALVO/,
      'Com await, uma falha do monitoramento atrasaria o caminho de segurança que ele observa.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A-3 — a Política promete export JSON; ele precisa existir de verdade', () => {
  test('a promessa segue na Política (se sair, o teste avisa para reavaliar)', () => {
    // Casar a FRASE inteira travava a redação: em 2026-07-30 a Política passou a
    // citar também a planilha, e este teste reprovou uma mudança que só ampliou
    // a promessa. O que precisa continuar verdadeiro é o COMPROMISSO — exportar,
    // e em JSON —, não um conjunto exato de palavras.
    const pol = ler('privacidade.html')
    assert.match(pol, /\bJSON\b/,
      'A Política deixou de citar JSON. É o formato "estruturado e interoperável" do '
      + 'art. 18, V — se ele saiu do texto, a promessa mudou e este teste (e o botão) '
      + 'precisam ser reavaliados de propósito, não por acidente.')
    assert.match(pol, /exporta|baixar seus dados|baixar meus dados/i,
      'Sumiu qualquer menção a exportar. Enquanto a promessa estiver lá, o recurso é '
      + 'obrigatório (LGPD art. 18, V).')
  })

  test('a Política não promete formato que o app não entrega', () => {
    // O caminho inverso do teste acima, e o mais perigoso: prometer no documento
    // legal algo que o código não faz foi exatamente o achado A-3 original.
    const pol  = ler('privacidade.html')
    const mont = ler('src', 'scripts', 'modules', 'export-planilha.js')
    if (/\.xlsx|planilha/i.test(pol)) {
      assert.ok(mont.includes('montarPlanilha'),
        'A Política cita planilha, mas o módulo que a monta não existe mais.')
    }
  })

  test('existe o botão e ele carrega o módulo de exportação', () => {
    assert.match(ler('dashboard.html'), /id="btnExportarDados"/,
      'Sem o botão, a promessa da Política volta a ser falsa.')
    assert.match(ler('src', 'scripts', 'pages', 'db-configuracoes.js'),
      /import\(['"]\.\.\/modules\/export-dados\.js['"]\)/,
      'O módulo tem de ser lazy: só quem exporta paga o download.')
  })

  test('exporta TODOS os perfis, não só o aberto', () => {
    const m = ler('src', 'scripts', 'modules', 'export-dados.js')
    assert.match(m, /fetch\('\/api\/user-data'/,
      'O blob tem de vir do servidor. A memória do dashboard só tem o perfil ATIVO, e '
      + 'portabilidade exige todos os perfis do titular.')
  })

  test('nenhuma credencial entra no arquivo', () => {
    const m = ler('src', 'scripts', 'modules', 'export-dados.js')
    for (const proibido of ['code_hash', 'password', 'access_token', 'refresh_token',
                            'DATA_ENCRYPTION', 'device_hash', 'p256dh']) {
      const usos = m.split('\n').filter(l =>
        l.includes(proibido) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      // `password` aparece legitimamente no step-up (confirmar senha), nunca no pacote.
      const noPacote = usos.some(l => /select\(|_montar|dados_financeiros|metadados/.test(l))
      assert.ok(!noPacote,
        `"${proibido}" não pode entrar no arquivo exportado: ele carrega os DADOS do titular, `
        + 'não o ACESSO dele.')
    }
  })

  test('exige confirmação de senha (step-up do Passo 25)', () => {
    assert.match(ler('src', 'scripts', 'modules', 'export-dados.js'), /verify-password/,
      'Ver os dados na tela exige navegar; baixar o arquivo é um clique. Com uma sessão '
      + 'esquecida aberta, é a diferença entre bisbilhotar e exfiltrar.')
    assert.match(ler('api', 'auth-session.js'), /action === 'verify-password'/,
      'O endpoint de step-up sumiu — a confirmação viraria no-op.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M-1 — o sitemap prometido no robots.txt precisa existir', () => {
  test('sitemap.xml existe e é XML válido de sitemap', () => {
    const xml = ler('public', 'sitemap.xml')
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
      'O robots.txt aponta para /sitemap.xml desde sempre; sem o arquivo o Google leva 404.')
  })

  test('não anuncia nenhuma rota que o robots manda NÃO indexar', () => {
    const robots = ler('public', 'robots.txt')
    const xml    = ler('public', 'sitemap.xml')
    const negadas = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map(m => m[1])
    const anunciadas = [...xml.matchAll(/<loc>https:\/\/www\.granaevo\.com(\/[^<]*)<\/loc>/g)].map(m => m[1])
    const conflito = anunciadas.filter(r => negadas.some(d => d !== '/' && r.startsWith(d)))
    assert.deepEqual(conflito, [],
      `O sitemap anuncia rota bloqueada no robots: ${conflito.join(', ')}. Anunciar ao Google `
      + 'uma URL que o robots proíbe é sinal contraditório — e as rotas negadas aqui são as '
      + 'autenticadas (/dashboard, /convidados), que não têm conteúdo indexável.')
  })

  test('é gerado no prebuild, não mantido à mão', () => {
    const pkg = JSON.parse(ler('package.json'))
    assert.match(pkg.scripts.prebuild, /build-sitemap\.mjs/,
      'Sitemap estático nasce com lastmod errado no dia seguinte, e lastmod mentiroso faz o '
      + 'Google ignorar o arquivo inteiro.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('CSP — não liberar terceiro que não está no caminho', () => {
  test('cloudflareinsights fora da CSP enquanto o Cloudflare não entrar', () => {
    // Detecta a DIRETIVA de verdade, não o texto solto: o comentário que explica
    // a remoção cita os dois hosts, e um regex ingênuo casaria com ele — foi
    // exatamente o falso positivo que esta versão corrige.
    const cspsDoVercel = JSON.parse(ler('vercel.json')).headers
      .flatMap(h => h.headers)
      .filter(h => h.key === 'Content-Security-Policy')
      .map(h => h.value)

    const metaCsp = (ler('index.html')
      .match(/http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)"/) ?? [])[1]

    for (const csp of [...cspsDoVercel, metaCsp].filter(Boolean)) {
      assert.ok(!csp.includes('cloudflareinsights'),
        'Uma CSP libera cloudflareinsights. Conferido em 2026-07-27: os nameservers são do '
        + 'Hostinger e nenhum host devolve cf-ray — o Cloudflare não está no caminho, então '
        + 'isso é superfície aberta sem contrapartida. Se o Cloudflare entrar '
        + '(docs/cloudflare-runbook.md), reverta este teste junto.')
    }
    assert.ok(cspsDoVercel.length >= 5, 'As CSPs do vercel.json sumiram — confira o arquivo.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M-5 — nenhuma tabela com PII pode ficar sem prazo de descarte', () => {
  const mig = ler('supabase', 'migrations', '20260727070000_retencao_backups_e_convites.sql')

  test('profile_backups cobre os status TERMINAIS, não só o active', () => {
    assert.match(mig, /status IN \('pending', 'cancelled', 'restored'\)/,
      'O cron granaevo-expire-profile-backups só trata status=active. O ciclo real também '
      + 'produz cancelled (downgrade desfeito) e restored (upgrade de volta), além de pending '
      + 'órfão — e nesses a linha guarda member_data, o SNAPSHOT COMPLETO do perfil.')
  })

  test('usa coalesce(updated_at, created_at), não backup_expires_at', () => {
    assert.match(mig, /coalesce\(updated_at, created_at\)/,
      'backup_expires_at só é preenchido pelo webhook e nesses status costuma ser NULL — '
      + 'usá-lo faria a rotina rodar todo dia sem pegar nada, que é o pior tipo de falha: '
      + 'a que parece funcionar.')
  })

  test('o prazo bate com o que a Política declara', () => {
    assert.match(mig, /interval '90 days'/,
      'privacidade.html promete "backups de perfil por 90 dias". Prazo no sistema diferente '
      + 'do publicado é não-conformidade mesmo que o sistema seja mais rígido.')
    assert.match(ler('privacidade.html'), /90 dias/,
      'Se a Política mudou o prazo, a rotina precisa mudar junto.')
  })

  test('as duas rotinas estão agendadas', () => {
    for (const job of ['granaevo-purge-profile-backups-terminais', 'granaevo-purge-guest-invitations']) {
      assert.ok(mig.includes(`'${job}'`),
        `Função sem cron é código morto: a PII continua acumulando. Falta agendar ${job}.`)
    }
  })

  test('as funções DEFINER têm search_path fixo', () => {
    const defs = mig.match(/SECURITY DEFINER\s*\n\s*SET search_path/g) ?? []
    assert.equal(defs.length, 2,
      'DEFINER sem search_path fixo é vetor de escalada — padrão do projeto e do advisor.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('O-1 — o que saiu do boot do dashboard não pode voltar', () => {
  const dash = ler('src', 'scripts', 'pages', 'dashboard.js')

  test('partículas e paleta são importadas dinamicamente, nunca no topo', () => {
    // Comparação de string, não regex: o caminho tem `(`, `.` e `/`, e escapar
    // isso dentro de template literal já me custou um falso negativo — o `\(`
    // virava `(` na fonte do RegExp e os parênteses viravam grupo de captura.
    for (const mod of ['particulas', 'command-palette']) {
      assert.ok(dash.includes(`import('../modules/${mod}.js')`),
        `${mod} precisa continuar sendo import() dinâmico.`)
      assert.ok(!dash.split('\n').some(l => l.startsWith(`import `) && l.includes(`modules/${mod}.js`)),
        `${mod} virou import estático — volta inteiro para o chunk de boot, que já vive no teto.`)
    }
  })

  test('as guardas ficam ANTES do import das partículas', () => {
    const bloco = dash.match(/FUNDO ANIMADO[\s\S]*?\}\);/)[0]
    const iMobile = bloco.indexOf('innerWidth <= 768')
    const iImport = bloco.indexOf("import('../modules/particulas.js')")
    assert.ok(iMobile > -1 && iMobile < iImport,
      'O objetivo é NÃO BAIXAR o módulo em mobile. Checar lá dentro seria tarde demais — '
      + 'o download já teria acontecido.')
  })

  test('o Ctrl+K NÃO é registrado dentro do módulo da paleta', () => {
    const pal = ler('src', 'scripts', 'modules', 'command-palette.js')
    assert.doesNotMatch(pal, /document\.addEventListener\('keydown'/,
      'O atalho vive no stub do dashboard.js, que é quem decide carregar o módulo. '
      + 'Registrar de novo aqui faria o Ctrl+K disparar duas vezes e a paleta abrir e '
      + 'fechar no mesmo toque.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('Landing — a vitrine prova capacidade sem entregar o valor', () => {
  const demo = ler('src', 'scripts', 'pages', 'landing-demo.js')
  const css  = ler('src', 'styles', 'landing-demo.css')
  const html = ler('index.html')

  test('a parede existe e é baixa o bastante para interromper', () => {
    const m = demo.match(/const MAX_ITENS = (\d+)/)
    assert.ok(m, 'MAX_ITENS sumiu.')
    const max = Number(m[1])
    assert.ok(max >= 2 && max <= 6,
      `MAX_ITENS = ${max}. Acima de ~6 a parede deixa de existir na prática (ninguém digita `
      + 'tanto numa landing) e a demo volta a saciar em vez de criar desejo. Abaixo de 2, os '
      + 'insights não têm material — renderInsights exige 2 itens.')
  })

  test('o formulário some de verdade quando a parede aparece', () => {
    assert.match(css, /\.trial-form\[hidden\]\s*\{\s*display:\s*none/,
      'O `hidden` do HTML só funciona pela regra do user-agent, e `.trial-form{display:flex}` '
      + 'a vence. Sem esta regra, a parede aparece COM o formulário ainda ativo ao lado — foi '
      + 'exatamente o bug que quase subiu.')
  })

  test('a parede é reativa: apagar um lançamento devolve o formulário', () => {
    assert.match(demo, /form\.hidden\s*=\s*naParede/,
      'A parede tem de ser calculada no render(), não setada uma vez. Ela marca um momento, '
      + 'não tranca uma porta.')
  })

  test('só o primeiro insight vem completo', () => {
    assert.match(demo, /const \[primeiro, \.\.\.retidos\] = visiveis/,
      'Os três insights completos entregavam o diagnóstico inteiro de graça — prova de '
      + 'capacidade virava entrega de valor, e não sobrava razão para entrar.')
    assert.match(demo, /trial-insight--retido/,
      'Os retidos precisam de tratamento visual próprio, senão não se lê que estão fechados.')
  })

  test('o retido mostra o título e esconde o corpo', () => {
    const bloco = demo.slice(demo.indexOf('const [primeiro'))
    assert.match(bloco, /Encontrei mais/,
      'Ver que o app ACHOU mais é mais forte que não mostrar nada.')
    assert.ok(!/for \(const \[, titulo, texto\] of retidos/.test(bloco),
      'Se o texto do insight retido for renderizado, o portão não fecha nada.')
  })

  test('a borda nomeia o que fica dentro, incluindo o import do extrato', () => {
    assert.match(html, /trial-borda/,
      'Sem a borda à vista, o visitante assume que o que ele viu É o produto.')
    assert.match(html, /import do extrato do seu banco/,
      '"Vou ter que digitar tudo?" é a objeção que mata a venda. A resposta tem de aparecer '
      + 'como promessa nomeada — não como demonstração, que entregaria o diferencial.')
  })

  test('a demo continua sem persistir nada (invariante do arquivo)', () => {
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(demo),
      'O cabeçalho do arquivo trata a ausência de persistência como decisão de LGPD: guardar '
      + 'o que o visitante digitou faz a landing deixar de ser vitrine e virar produto '
      + '(consentimento, retenção, titular). Nem para "levar os dados ao cadastro".')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('apex → www — nenhuma URL aponta para o domínio sem www', () => {
  // `granaevo.com` responde 308 para `www.granaevo.com`. Como apex e www são
  // ORIGENS DIFERENTES, o fetch **remove o header Authorization** no redirect
  // (regra da spec). Uma chamada autenticada ao apex volta 401 com token válido
  // — verificado em produção em 2026-07-30: mesmo token deu 200 no www e 401 no
  // apex.
  //
  // Hoje nada quebra: o 308 leva a navegação para www e os fetches do app são
  // relativos. O risco é o dia em que alguém escrever a URL inteira à mão.
  //
  // Origem SEM caminho (`'https://granaevo.com'`) continua permitida de
  // propósito: são entradas de ALLOWED_ORIGINS, e recusar a origem apex não
  // ajudaria em nada.
  const dirs = [['api'], ['src', 'scripts'], ['supabase', 'functions']]

  const arquivos = (partes) => {
    const raiz = join(RAIZ, ...partes)
    const anda = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? anda(join(d, e.name))
        : (/\.(ts|js|mjs)$/.test(e.name) ? [join(d, e.name)] : []))
    return anda(raiz)
  }

  test('nenhum arquivo escreve https://granaevo.com/<caminho>', () => {
    const culpados = []
    for (const partes of dirs) {
      for (const arq of arquivos(partes)) {
        const src = readFileSync(arq, 'utf8')
        if (/https:\/\/granaevo\.com\//.test(src)) culpados.push(relative(RAIZ, arq))
      }
    }
    assert.deepEqual(culpados, [],
      'Estes arquivos apontam para o domínio SEM www:\n  ' + culpados.join('\n  ')
      + '\n\nUse https://www.granaevo.com/ — é o canônico do site (canonical e sitemap), '
      + 'evita um salto 308 em cada link, e fecha a armadilha do Authorization sumindo '
      + 'em redirect entre origens.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-6 — nenhuma edge cai numa chave legada (elas estão desativadas)', () => {
  const raiz = join(RAIZ, 'supabase', 'functions')

  const tsDe = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? tsDe(join(dir, e.name)) : (e.name.endsWith('.ts') ? [join(dir, e.name)] : []))

  test('SUPABASE_SERVICE_ROLE_KEY e SUPABASE_ANON_KEY não aparecem em nenhuma função', () => {
    // As duas legadas foram DESATIVADAS em 2026-07-23 e devolvem
    // 401 "Legacy API keys are disabled". Um fallback para chave morta não é
    // rede de segurança: troca um erro de configuração legível por um 401 sem
    // explicação — e ainda dá a impressão de que existe um plano B.
    const culpados = []
    for (const arq of tsDe(raiz)) {
      const src = readFileSync(arq, 'utf8')
      const codigo = src.split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      if (/SUPABASE_(SERVICE_ROLE|ANON)_KEY/.test(codigo)) culpados.push(relative(RAIZ, arq))
    }
    assert.deepEqual(culpados, [],
      'Estas funções voltaram a ler uma chave legada desativada:\n  ' + culpados.join('\n  '))
  })

  test('quem não acha a chave nova FALHA ALTO, não devolve string vazia', () => {
    // `return '' ` cria um client com credencial vazia: a função sobe, aceita a
    // requisição e só falha lá adiante, com 401. O erro real (env ausente) fica
    // invisível. Falhar no getSecretKey aponta a causa de primeira.
    const g = readFileSync(join(raiz, 'get-user-data', 'index.ts'), 'utf8')
    const fn = g.match(/function getSecretKey[\s\S]*?\n\}/)?.[0] ?? ''
    assert.match(fn, /throw new Error/,
      'getSecretKey precisa lançar quando SUPABASE_SECRET_KEYS não serve.')
    assert.ok(!/return\s*''/.test(fn),
      'Sobrou um `return \'\'` — credencial vazia vira 401 confuso em vez de erro de config.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('login por código de recuperação — entra sem alarme falso', () => {
  test('a recuperação devolve a sessão, não só o aviso de 2FA desligado', () => {
    const api = ler('src', 'scripts', 'services', 'mfa-api.js')
    assert.match(api, /return \{ data, mfaDisabled/,
      'recoverMfaLogin precisa devolver `data`. O servidor manda a sessão completa '
      + '(mesmo sessionPayload do TOTP, com `user`); devolver só `mfaDisabled` deixava '
      + 'o login sem dados para seguir.')
  })

  test('o login não recebe data:null no caminho de recuperação', () => {
    const js = ler('src', 'scripts', 'pages', 'login.js')
    assert.ok(!/fechar\(\{\s*data:\s*null/.test(js),
      'O gate de MFA fechava com `data: null` na recuperação, e o fluxo de login lê '
      + '`data.user` logo depois. O TypeError caía no catch geral e virava "Erro de '
      + 'conexão" — com a sessão JÁ criada, então o F5 entrava. Bug que mente sobre a '
      + 'própria causa e some ao recarregar.')
  })

  test('a leitura do usuário é opcional-chained', () => {
    // Sem tirar os comentários, o teste casa com o comentário que EXPLICA o bug
    // e reprova o código correto. Já aconteceu aqui antes, com a regra de CSP.
    const js = ler('src', 'scripts', 'pages', 'login.js')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(!/[^?.]\bdata\.user\b/.test(js),
      'Acesso direto a `data.user` no login. O catch daquele bloco é cego: ele traduz '
      + 'qualquer exceção em "Erro de conexão", então um acesso não-protegido some do '
      + 'radar em vez de aparecer.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('step-up de senha — provar a senha não pode deslogar quem provou', () => {
  const bff = ler('api', 'auth-session.js')

  test('todo /logout de sessão de VERIFICAÇÃO usa scope=local', () => {
    // O bug de 2026-07-30. `verify-password` e `mfa-disable` fazem um
    // grant_type=password só para provar que a pessoa sabe a senha. Isso cria
    // uma sessão paralela de verdade, que precisa ser revogada — mas o
    // `/logout` do GoTrue é **global por padrão** e apaga TODAS as sessões do
    // usuário, inclusive a que ele está usando naquele instante.
    //
    // Em produção: exportação LGPD confirmava a senha, recebia {ok:true}, e o
    // GET /api/user-data seguinte respondia 401 "Token inválido".
    // Reproduzido: 200 → step-up 200 → 401.
    const logouts = [...bff.matchAll(/gotrue\('logout([^']*)'/g)].map(m => m[1])
    assert.ok(logouts.length >= 2,
      `Esperava ao menos 2 chamadas de logout (step-up e mfa-disable), achei ${logouts.length}.`)

    // A do action 'logout' (o usuário saindo de fato) é a única que pode ser
    // global — ali derrubar todas as sessões é o comportamento desejado.
    const semEscopo = logouts.filter(q => !q.includes('scope='))
    assert.ok(semEscopo.length <= 1,
      `${semEscopo.length} chamadas de /logout sem escopo. Só o logout de verdade pode ser `
      + 'global; as sessões criadas para verificar senha PRECISAM de ?scope=local, senão '
      + 'confirmar a senha desloga o usuário no meio do fluxo.')
  })

  test('os dois grants de verificação revogam a sessão que criaram', () => {
    // Sem revogar, cada confirmação de senha deixa um refresh token órfão vivo
    // no GoTrue — sessão que ninguém usa e que ninguém expira.
    for (const acao of ['verify-password', 'mfa-disable']) {
      // `if (action === ...)` e não só `action === ...`: 'mfa-disable' também
      // aparece numa cadeia de OR bem antes do bloco de verdade, e casar com
      // ela media o trecho errado do arquivo.
      const i = bff.indexOf(`if (action === '${acao}')`)
      assert.ok(i > -1, `Não achei o bloco de ${acao}.`)

      // Recorta até o PRÓXIMO `if (action ===`, e não uma janela de N chars.
      // A janela fixa era 4000 e reprovou em 2026-08-11 sem nada ter sido
      // removido: o bloco de verify-password cresceu (ganhou o lockout por
      // conta do SEC-003) e empurrou a revogação para o offset 4207. O de
      // mfa-disable estava a 12 caracteres de cair pelo mesmo motivo.
      // Um teste de segurança que reprova quando o arquivo ENGORDA treina
      // quem mantém a suíte a aumentar o número até o vermelho sumir — que é
      // como uma verificação de verdade morre. Delimitar pelo bloco não tem
      // essa falha e ainda cobre o bloco INTEIRO, não só os primeiros 4000.
      const resto = bff.slice(i + `if (action === '${acao}')`.length)
      const j     = resto.indexOf('if (action ===')
      const bloco = resto.slice(0, j === -1 ? undefined : j)

      assert.match(bloco, /gotrue\('logout\?scope=local'/,
        `O bloco de ${acao} faz grant_type=password e não revoga a sessão criada — `
        + 'refresh token órfão a cada uso.')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-2 — o captcha é exigido pelo SERVIDOR, não pelo navegador', () => {
  const bff = ler('api', 'auth-session.js')

  test('o gate lê o contador SEM incrementar', () => {
    assert.match(bff, /readCounter\(kFail\)/,
      'Usar bumpCounter aqui puniria quem ACERTA a senha: o gate roda antes de saber '
      + 'se a credencial está certa, então incrementar transformaria todo login válido '
      + 'em mais um passo rumo ao lockout.')
  })

  test('o gate roda ANTES do password grant', () => {
    const iGate  = bff.indexOf('precisaCaptcha')
    const iGrant = bff.indexOf("gotrue('token?grant_type=password'")
    assert.ok(iGate > -1 && iGate < iGrant,
      'Se o captcha fosse checado depois do grant, o atacante já teria gastado uma '
      + 'tentativa de senha — e o custo dele por tentativa continuaria zero.')
  })

  test('o limiar fica ABAIXO do primeiro degrau de lockout', () => {
    const cap = Number(bff.match(/const CAPTCHA_APOS_FALHAS = (\d+)/)?.[1])
    const menorLock = Math.min(...[...bff.matchAll(/falhas:\s*(\d+)/g)].map(m => Number(m[1])))
    assert.ok(cap < menorLock,
      `Captcha em ${cap} e lockout em ${menorLock}: o captcha PRECISA vir antes, senão o `
      + 'usuário legítimo que errou a senha bate direto no bloqueio de 15 minutos sem '
      + 'nunca ter a chance de provar que é humano.')
  })

  test('a validação do Turnstile falha ABERTO', () => {
    // Extraída para api/_turnstile.js em 2026-08-04, quando o cadastro (Passo 26)
    // virou o 2º chamador. O prefixo `_` importa: a Vercel não conta o arquivo
    // como Serverless Function, e o plano Hobby já está no teto de 12.
    const fn = ler('api', '_turnstile.js').match(/export async function turnstileOk[\s\S]*?\n\}/)[0]

    // Contar retornos em vez de casar distância entre trechos: a 1ª versão deste
    // teste limitava a 200 caracteres entre `if (!secret)` e `return true`, e o
    // comentário que explica a decisão empurrou o retorno para além disso — teste
    // frágil reprovando código correto.
    const abre  = (fn.match(/return true/g)  ?? []).length
    const fecha = (fn.match(/return false/g) ?? []).length

    assert.ok(abre >= 3,
      `turnstileOk tem só ${abre} caminho(s) que liberam. Precisa de 3: sem chave `
      + 'configurada, gateway fora do ar, e timeout. Indisponibilidade da Cloudflare não '
      + 'pode trancar o usuário fora da própria conta — o lockout por conta continua '
      + 'barrando força bruta, e o captcha é a TERCEIRA camada deste caminho.')

    assert.ok(fecha >= 1,
      'turnstileOk precisa recusar token malformado — falhar aberto é para indisponibilidade '
      + 'do fornecedor, não para entrada inválida.')

    assert.match(fn, /if \(!secret\)/,
      'Sem TURNSTILE_SECRET_KEY o gate tem de ser no-op, senão um deploy sem a env var '
      + 'derruba o login de todo mundo que errou a senha 3 vezes.')

    // Uma implementação só. A política de falhar aberto é sutil demais para
    // viver em duas cópias que divergem — ainda mais agora que ela protege dois
    // caminhos com custos diferentes: conta trancada (login) e porta paga
    // fechada (cadastro).
    for (const rota of ['auth-session.js', 'create-account.js']) {
      assert.match(ler('api', rota), /import \{ turnstileOk \}\s+from '\.\/_turnstile\.js'/,
        `api/${rota} precisa IMPORTAR o gate compartilhado, não reimplementá-lo.`)
      assert.doesNotMatch(ler('api', rota), /async function turnstileOk/,
        `api/${rota} voltou a ter cópia local do gate — é assim que duas versões divergem.`)
    }
  })

  test('nenhum vestígio do Google no caminho do login', () => {
    for (const arq of [['login.html'], ['vercel.json'], ['src','scripts','pages','login.js']]) {
      assert.ok(!/google\.com\/recaptcha|gstatic\.com\/recaptcha|grecaptcha/.test(ler(...arq)),
        `${arq.join('/')} ainda referencia o reCAPTCHA do Google. O produto se vende por `
        + 'privacidade e carregava rastreador de terceiro justamente na tela de login.')
    }
  })

  test('as edges validam contra a Cloudflare, sem fallback na chave antiga', () => {
    // `verify-recaptcha` saiu da lista em 2026-08-03: a edge foi apagada junto
    // com o proxy `/api/verify-recaptcha` e a função morta que a chamava. Era
    // resquício da migração pro Turnstile — o captcha do login é exigido pelo
    // servidor via `captchaToken` do Supabase, não por esse caminho.
    for (const edge of ['verify-and-reset-password']) {
      const src = ler('supabase', 'functions', edge, 'index.ts')
      assert.match(src, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/,
        `${edge} ainda chama o siteverify do Google.`)
      assert.ok(!src.includes('RECAPTCHA_SECRET_KEY'),
        `${edge} mantém fallback na env legada — um token do Google jamais validaria no `
        + 'Turnstile, então aceitar a chave antiga só mascararia um deploy incompleto.')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B-2 (UI) — não sondar o DOM do widget do Turnstile', () => {
  test('nenhuma heurística de offsetWidth destrói o widget', () => {
    const js = ler('src', 'scripts', 'pages', 'login.js')
    const codigo = js.split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    assert.ok(!codigo.includes('offsetWidth'),
      'Sondar o tamanho do iframe era um truque válido para o reCAPTCHA, que pinta a '
      + 'caixinha na hora. O Turnstile em modo Managed roda a verificação INVISÍVEL '
      + 'primeiro e fica legitimamente 0x0 nesse intervalo — a sonda lia isso como '
      + 'falha, destruía o widget e re-renderizava. Sintoma em produção: piscou 3 vezes '
      + 'e sumiu. O error-callback do próprio Turnstile já cobre falha de verdade.')
  })

  test('os callbacks vão como FUNÇÃO, nunca como nome de função', () => {
    const js = ler('src', 'scripts', 'pages', 'login.js')

    // O que quebrou em produção: `_renderCaptchaInContainer` recebia
    // { resolved: 'onLoginCaptchaResolved', ... } — strings, convenção do
    // reCAPTCHA, que resolvia o nome contra o window sozinho. O Turnstile não
    // resolve: guarda o valor e faz `s.call(...)`, que com string vira
    // `TypeError: s.call is not a function` lançado dentro do api.js DELE.
    //
    // O sintoma enganava: o desafio da Cloudflare passava, o widget mostrava
    // "Sucesso!", e mesmo assim o login respondia "resolva a verificação de
    // segurança" — porque o callback morria antes de marcar o token.
    const chamadas = js.match(/_renderCaptchaInContainer\(\s*[\s\S]{0,400}?\n\s*\)/g) ?? []
    assert.ok(chamadas.length >= 2,
      `Esperava as 2 chamadas de _renderCaptchaInContainer (login e código), achei ${chamadas.length}.`)

    for (const chamada of chamadas) {
      assert.ok(!/resolved:\s*['"]/.test(chamada),
        'Callback do Turnstile passado como STRING. Ele exige a referência da função — '
        + 'com string o widget resolve o desafio e mesmo assim o login barra o usuário, '
        + 'porque o token nunca é marcado. Use os `handlers` do estado do captcha.')
    }

    // A trava que dá nome ao culpado em vez de deixar o erro estourar sem
    // origem lá dentro do api.js da Cloudflare. Migrou para o módulo
    // compartilhado em 2026-08-04, quando o cadastro virou o 3º widget: ela
    // precisa valer para TODAS as telas, não só para o login.
    const mod = ler('src', 'scripts', 'modules', 'turnstile-state.js')
    assert.match(mod, /typeof callbacks\?\.\[nome\] !== 'function'/,
      'Sumiu a guarda que recusa render com callback que não é função. Sem ela, esta '
      + 'classe de bug volta a se manifestar como um TypeError sem origem aparente.')
    assert.match(js, /callbacksValidos\(callbacks/,
      'O login precisa CHAMAR a guarda compartilhada — tê-la no módulo não basta.')
  })

  test('os handlers e os globais são a MESMA função', () => {
    // Mora no módulo compartilhado desde 2026-08-04 (login, tela de código e
    // cadastro usam a mesma fábrica).
    const js = ler('src', 'scripts', 'modules', 'turnstile-state.js')

    // Os globais (window.onLoginCaptchaResolved…) são citados no login.html e
    // continuam sendo o contrato público da tela. Se um dia alguém apontar os
    // `handlers` para outra implementação, os dois caminhos divergem e só um
    // deles marca o token — bug de novo, mais difícil de achar.
    assert.match(js, /window\[resolvedCallbackName\]\s*=\s*aoResolver/,
      'O global de sucesso precisa ser a MESMA referência que vai em handlers.resolved.')
    assert.match(js, /handlers:\s*\{\s*resolved:\s*aoResolver/,
      'handlers.resolved precisa reusar a função do global, não redeclarar outra.')
  })
})
