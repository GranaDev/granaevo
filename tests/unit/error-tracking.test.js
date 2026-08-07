/**
 * error-tracking — o vigia que não pode virar vazamento.
 *
 * O módulo existia desde sempre, importado por 4 páginas, e compilava para
 * DUAS FUNÇÕES VAZIAS em produção: sem `VITE_SENTRY_DSN`, todo o corpo era ramo
 * morto. O app não tinha visibilidade nenhuma de erro — e ninguém sabia.
 *
 * Ao ligá-lo, o risco troca de lado: um app de finanças passa a mandar texto de
 * erro para um operador nos EUA. Um "falha ao salvar R$ 1.234,56 de
 * fulano@email.com" numa mensagem de exceção é vazamento — e silencioso, porque
 * ninguém lê o que sai. É isso que este arquivo tranca.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(RAIZ, 'src/scripts/modules/error-tracking.js'), 'utf8')

// Os comentários deste projeto citam o próprio código que explicam — casar a
// asserção com um comentário já deu falso "passou" aqui antes. Só o código.
const CODIGO = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

// Importa o CÓDIGO DE VERDADE. Reconstruir as regexes a partir do texto-fonte
// (a 1ª versão deste arquivo) testava a minha cópia delas, não as do módulo —
// e quebrava só de alguém mudar o espaçamento da declaração.
const { _limpar: limpar, _semQuery: semQuery } =
  await import('../../src/scripts/modules/error-tracking.js')

describe('a peneira remove o que não pode sair daqui', () => {
  test('valor em R$ vira rótulo', () => {
    assert.equal(limpar('falha ao salvar R$ 1.234,56'), 'falha ao salvar [valor]')
    assert.equal(limpar('saldo r$ 90'), 'saldo [valor]')
  })

  test('e-mail vira rótulo', () => {
    assert.equal(limpar('usuário fulano.silva+tag@empresa.com.br não achado'),
      'usuário [email] não achado')
  })

  test('número longo (valor solto, id, documento) vira rótulo', () => {
    assert.equal(limpar('conta 123456789 inválida'), 'conta [num] inválida')
  })

  test('número curto SOBREVIVE — é o que ajuda a depurar', () => {
    // "status 500", "linha 42" precisam chegar legíveis, senão o relatório
    // de erro perde justamente a parte útil.
    assert.equal(limpar('status 500 na linha 42'), 'status 500 na linha 42')
  })

  test('e-mail é limpo ANTES do número — a ordem é o comportamento', () => {
    // Invertida, a regra de número longo comeria o trecho numérico do endereço
    // e o e-mail escaparia da regra seguinte, saindo pela metade.
    assert.equal(limpar('erro em joao123456@x.com'), 'erro em [email]')
  })

  test('texto sem dado sensível passa intacto', () => {
    assert.equal(limpar('TypeError: undefined is not a function'),
      'TypeError: undefined is not a function')
  })
})

describe('a URL não leva token nem id embutido', () => {
  test('query string e hash são cortados', () => {
    assert.equal(semQuery('https://granaevo.com/login?next=/dashboard&token=abc'),
      'https://granaevo.com/login')
    assert.equal(semQuery('https://granaevo.com/dashboard#reservas'),
      'https://granaevo.com/dashboard')
  })

  test('URL limpa fica como está', () => {
    assert.equal(semQuery('https://granaevo.com/dashboard'), 'https://granaevo.com/dashboard')
  })
})

describe('o que o módulo promete não enviar', () => {
  test('a peneira é aplicada à mensagem E ao valor da exceção', () => {
    // Antes só o envelope era limpo (cookies, headers). O conteúdo — que é onde
    // o dinheiro aparece — saía inteiro.
    assert.match(CODIGO, /event\.message = _limpar\(event\.message\)/)
    assert.match(CODIGO, /ex\.value = _limpar\(ex\.value\)/)
  })

  test('sem tracing e sem sessão: só erro', () => {
    // Tracing manda a URL de cada navegação e cada request pro Sentry. Num app
    // de finanças é dado a mais viajando em troca de quase nada.
    assert.match(CODIGO, /autoSessionTracking:\s*false/)
    assert.match(CODIGO, /integrations:\s*\[\]/)
    assert.ok(!/browserTracingIntegration|tracesSampleRate/.test(CODIGO),
      'tracing religado — o módulo volta a mandar navegação e requests')
  })

  test('a rejeição do registerSW é descartada, e SÓ ela', () => {
    // `registerSW.js` é gerado pelo VitePWA sem `.catch()`: quando o registro do
    // service worker falha (robô de busca, aba anônima), sai um "Rejected" sem
    // mensagem útil. O 1º caso real veio do Google-Read-Aloud — nenhum usuário
    // afetado, e sem service worker o app funciona igual.
    //
    // O filtro casa pelo NOME DO ARQUIVO na stack, e não pela mensagem: filtrar
    // por "Rejected" engoliria qualquer promessa rejeitada do app, que é
    // justamente o tipo de erro que a gente quer ver.
    assert.match(CODIGO, /includes\('registerSW\.js'\)/)
    assert.match(CODIGO, /stacktrace\?\.frames/)
    assert.ok(!/ignoreErrors[\s\S]{0,300}Rejected/.test(CODIGO),
      'filtrar pela mensagem esconderia rejeições reais do app')
  })

  test('PII desligada explicitamente', () => {
    assert.match(CODIGO, /sendDefaultPii:\s*false/)
  })

  test('o e-mail nunca chega ao Sentry, nem por engano', () => {
    // setUserContext manda pseudônimo + plano. Nada mais.
    const fn = CODIGO.match(/export function setUserContext[\s\S]*?\n\}/)[0]
    assert.ok(!/email/i.test(fn), 'setUserContext voltou a tocar em e-mail')
    assert.match(fn, /anon_/)
    // E quem chama também não passa mais.
    const DASH = readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8')
    assert.match(DASH, /setUserContext\(\{ id: usuarioLogado\.userId, plan: usuarioLogado\.plano \}\)/)
  })

  test('o pseudônimo não é reversível, e o UUID nunca vai cru', () => {
    // FNV-1a de 32 bits: sem a lista de UUIDs, o Sentry não reidentifica ninguém.
    assert.match(CODIGO, /function _pseudoId/)
    const fn = CODIGO.match(/export function setUserContext[\s\S]*?\n\}/)[0]
    // O valor enviado é SEMPRE o pseudônimo prefixado — o `user?.id` que aparece
    // antes da interrogação é a condição do ternário, não o que vai pro Sentry.
    assert.match(fn, /id:\s*user\?\.id \? `anon_\$\{_pseudoId\(/)

    // E o objeto entregue ao setUser tem EXATAMENTE dois campos. É a asserção
    // que pega o risco real: alguém acrescentar `email:` ou `username:` ali
    // amanhã passaria por qualquer verificação que só olhasse o campo `id`.
    const obj = fn.match(/setUser\(\{([\s\S]*?)\}\)/)[1]
    const campos = [...obj.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort()
    assert.deepEqual(campos, ['id', 'plan'])
  })
})

describe('o vigia não atrapalha quem ele vigia', () => {
  test('escuta desde já, carrega o SDK no ocioso', () => {
    // Os dois na ordem certa: sem os listeners antes do await, os erros do boot
    // — os piores — aconteceriam antes de existir quem os ouvisse.
    const i = CODIGO.indexOf('_ouvirDesdeJa()')
    const j = CODIGO.indexOf('await _quandoOcioso()')
    const k = CODIGO.indexOf("await import('@sentry/browser')")
    assert.ok(i > 0 && j > i && k > j, 'ordem: ouvir → ocioso → importar')
  })

  test('a espera pelo ocioso tem teto', () => {
    // Aba em segundo plano nunca fica ociosa; sem timeout o SDK jamais entraria.
    assert.match(CODIGO, /timeout: 5000/)
  })

  test('a fila tem limite — loop de erro não vira vazamento', () => {
    assert.match(CODIGO, /FILA_MAX = \d+/)
    assert.match(CODIGO, /_fila\.length < FILA_MAX/)
  })

  test('a fila é entregue ao SDK quando ele chega', () => {
    assert.match(CODIGO, /_entregarFila\(\)/)
    assert.match(CODIGO, /_fila\.splice\(0\)/)
  })

  test('se o SDK falhar, a ponte é desarmada', () => {
    // Guardar erro numa fila que ninguém vai ler só consome memória e segura
    // referências de objetos já mortos.
    const cat = CODIGO.match(/catch \(err\)[\s\S]*?\n  \}/)[0]
    assert.match(cat, /_fila\.length = 0/)
    assert.match(cat, /removeEventListener/)
  })
})

describe('o desligamento é o estado padrão, e é honesto', () => {
  test('sem DSN o módulo sai na primeira linha', () => {
    assert.match(CODIGO, /if \(!IS_PROD \|\| !SENTRY_DSN\) \{/)
  })

  test('o logout limpa o pseudônimo', () => {
    // Aparelho compartilhado (conta casal/família): sem isto os erros de quem
    // entrar depois sairiam agrupados sob quem saiu.
    const CLI = readFileSync(join(RAIZ, 'src/scripts/services/supabase-client.js'), 'utf8')
    assert.match(CLI, /clearUserContext\(\)/)
  })

  test('as flags de poda do Sentry estão no build', () => {
    const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
    assert.match(VITE, /__SENTRY_TRACING__:\s*false/)
    assert.match(VITE, /__SENTRY_DEBUG__:\s*false/)
  })
})
