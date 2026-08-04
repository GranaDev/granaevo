/**
 * Passo 26 — captcha no cadastro.
 *
 * Era a única porta do produto sem captcha, e é a porta PAGA. Antes disto, o
 * `/api/create-account` aceitava `send-code` defendido só por rate-limit por IP
 * (5/hora) e por e-mail (3/hora) mais honeypot. Isso segura script bobo; não
 * segura botnet, onde cada IP pede uma vez só e nenhum contador chega a disparar.
 *
 * Este arquivo tranca as decisões que não se leem no código sozinhas: a ORDEM
 * do gate, a política de falha, e o fato de o widget não existir para quem só
 * está olhando preço.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

const API    = ler('api', 'create-account.js')
const PLANOS = ler('src', 'scripts', 'pages', 'planos.js')
const HTML   = ler('planos.html')
const VERCEL = ler('vercel.json')

describe('o gate no servidor', () => {
  test('existe, e no send-code', () => {
    // O `send-code` é o ponto que dispara um e-mail para um endereço que o
    // solicitante ainda não provou possuir. O 2º passo (criar a conta) já exige
    // posse do código, então captcha lá seria atrito sem ganho.
    const bloco = API.slice(API.indexOf("if (action === 'send-code')"))
    assert.match(bloco, /await turnstileOk\(captchaToken, ipSC, PATH\)/)
  })

  test('vem DEPOIS dos rate limits e ANTES do envio do e-mail', () => {
    // Ordem é economia e é segurança:
    //  - depois dos limites: eles são locais e baratos; quem já estourou a cota
    //    não merece uma ida à rede.
    //  - antes do envio: é o disparo do e-mail que se quer impedir.
    const rate = API.indexOf('signup-code:mail:')
    const cap  = API.indexOf('turnstileOk(captchaToken')
    const send = API.indexOf('functions/v1/send-signup-code')
    assert.ok(rate > 0 && cap > 0 && send > 0, 'os três marcos precisam existir')
    assert.ok(rate < cap, 'o captcha não pode custar uma ida à rede a quem já estourou o limite')
    assert.ok(cap < send, 'o captcha precisa barrar ANTES de o e-mail sair')
  })

  test('o token é lido com tipagem defensiva', () => {
    assert.match(API, /const captchaToken = typeof parsed\?\.captchaToken === 'string'/)
  })

  test('recusa devolve 400 com mensagem que não ensina o atacante', () => {
    const bloco = API.slice(API.indexOf('turnstileOk(captchaToken'))
    assert.match(bloco, /status\(400\)/)
    // Não pode dizer "token ausente" vs "token inválido": isso vira oráculo.
    assert.match(bloco, /Verificação de segurança falhou/)
  })
})

describe('a política de falha é a mesma dos dois lados', () => {
  test('login e cadastro importam o MESMO gate', () => {
    for (const rota of ['auth-session.js', 'create-account.js']) {
      assert.match(ler('api', rota), /import \{ turnstileOk \}/,
        `api/${rota} precisa usar o gate compartilhado`)
    }
  })

  test('o gate mora em arquivo `_`, que não consome vaga da Vercel', () => {
    // O plano Hobby aceita 12 Serverless Functions e a 13ª congela o deploy em
    // silêncio (custou um dia em 2026-07-25). Um helper virando rota seria caro.
    assert.match(ler('api', '_turnstile.js'), /export async function turnstileOk/)
  })
})

describe('o widget só existe para quem vai se cadastrar', () => {
  test('renderiza na abertura do modal, não no load da página', () => {
    // Quem chega em /planos está olhando preço. Carregar e renderizar captcha
    // para todo visitante seria custo (e um terceiro no caminho) sem motivo.
    assert.match(PLANOS, /renderSignupCaptcha\(\);\s*\/\/ Passo 26/)
    const abre = PLANOS.indexOf("m.classList.add('open')")
    const rend = PLANOS.indexOf('renderSignupCaptcha();')
    assert.ok(abre > 0 && rend > abre, 'o render tem de estar dentro do open()')
  })

  test('o api.js é explícito — nada renderiza sozinho', () => {
    assert.match(HTML, /api\.js\?render=explicit&onload=__tsOnLoad/)
  })

  test('o turnstile-init vem ANTES do api.js e é SÍNCRONO', () => {
    // A corrida que este par resolve: planos.js é `type="module"` (sempre
    // diferido), então o api.js com `async` pode terminar antes dele e chamar
    // __tsOnLoad quando o callback ainda não existe.
    const init = HTML.indexOf('/scripts/modules/turnstile-init.js')
    const api  = HTML.indexOf('challenges.cloudflare.com/turnstile/v0/api.js')
    assert.ok(init > 0 && api > init, 'turnstile-init.js precisa vir primeiro')
    const tag = HTML.slice(init - 60, init + 60)
    assert.ok(!/async|defer/.test(tag), 'o init não pode ser async/defer — perde a corrida')
  })

  test('usa o nome de global que o init realmente expõe', () => {
    // `__tsPendingRender`, não um nome inventado: errar aqui faz o render
    // pendente nunca disparar, e o widget simplesmente não aparece.
    assert.match(PLANOS, /window\.__tsPendingRender = renderSignupCaptcha/)
    assert.match(ler('public', 'scripts', 'modules', 'turnstile-init.js'),
      /window\.__tsPendingRender/)
  })
})

describe('os callbacks — a regressão que já custou produção', () => {
  test('vão como FUNÇÃO, nunca como nome', () => {
    // Com string, o Turnstile faz `s.call(...)` e estoura dentro do api.js DELE:
    // o desafio passa, o widget diz "Sucesso!", e o envio é recusado assim mesmo.
    const bloco = PLANOS.slice(PLANOS.indexOf('turnstile.render(box'))
    assert.ok(!/callback:\s*['"]/.test(bloco), 'callback do Turnstile como STRING')
    assert.match(bloco, /callback:\s*SignupCaptcha\.handlers\.resolved/)
  })

  test('a guarda compartilhada é chamada antes do render', () => {
    const g = PLANOS.indexOf('callbacksValidos(SignupCaptcha.handlers')
    const r = PLANOS.indexOf('turnstile.render(box')
    assert.ok(g > 0 && r > g, 'a guarda precisa vir antes do render')
  })

  test('o cadastro reusa o estado compartilhado, sem cópia local', () => {
    assert.match(PLANOS, /import \{ createCaptchaState, callbacksValidos \}/)
    assert.ok(!/function _createCaptchaState/.test(PLANOS),
      'cópia local do estado — é assim que a invariante dos callbacks se perde de novo')
  })
})

describe('a CSP deixa o widget carregar (nas DUAS declarações)', () => {
  const CF = 'https://challenges.cloudflare.com'

  test('o <meta> do planos.html libera script, connect e frame', () => {
    const csp = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)">/)[1]
    for (const dir of ['script-src', 'connect-src', 'frame-src']) {
      const linha = csp.split(';').find((l) => l.trim().startsWith(dir))
      assert.ok(linha?.includes(CF), `${dir} do <meta> não libera o Turnstile`)
    }
  })

  test('o header do /planos no vercel.json libera os mesmos três', () => {
    // As duas declarações valem ao mesmo tempo e o navegador aplica a
    // INTERSEÇÃO — liberar só numa delas continua bloqueando.
    const bloco = VERCEL.slice(VERCEL.indexOf('"source": "/planos"', VERCEL.indexOf('"headers"')))
    const csp = bloco.slice(0, bloco.indexOf('\n    }'))
    for (const dir of ['script-src', 'connect-src', 'frame-src']) {
      const i = csp.indexOf(dir)
      assert.ok(i > 0, `${dir} ausente no header do /planos`)
      assert.ok(csp.slice(i, csp.indexOf(';', i)).includes(CF),
        `${dir} do vercel.json não libera o Turnstile`)
    }
  })

  test('frame-src deixou de ser none — o Turnstile roda em iframe', () => {
    const bloco = VERCEL.slice(VERCEL.indexOf('"source": "/planos"', VERCEL.indexOf('"headers"')))
    const csp = bloco.slice(0, bloco.indexOf('\n    }'))
    assert.ok(!/frame-src 'none'/.test(csp),
      "com frame-src 'none' o widget não aparece, e nada no console explica direito")
  })
})
