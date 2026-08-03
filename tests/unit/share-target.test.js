/**
 * Passo 12 — Share Target: compartilhar um texto de outro app vira lançamento.
 *
 * O ganho é grande (a notificação do banco vira gasto sem digitar nada), mas o
 * texto vem de FORA do app — é entrada não confiável, e traz valor e
 * estabelecimento junto. Este arquivo tranca as três coisas que, se afrouxarem,
 * transformam a conveniência em problema: não enviar sozinho, não deixar o
 * gasto na URL, e não abrir duas entradas na folha de compartilhamento.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANIFESTO = JSON.parse(readFileSync(join(RAIZ, 'public/assistente.webmanifest'), 'utf8'))
const PAGINA = readFileSync(join(RAIZ, 'src/scripts/pages/assistente.js'), 'utf8')
const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')

// Os comentários explicam o próprio código que descrevem; casar a asserção com
// um comentário já produziu um falso "passou" neste projeto. Só o código.
const CODIGO = PAGINA.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

describe('Passo 12 — o manifesto declara o alvo corretamente', () => {
  const st = MANIFESTO.share_target

  test('existe e entrega os três campos que o Android manda', () => {
    assert.ok(st, 'sem share_target o app não aparece na folha de compartilhamento')
    assert.deepEqual(st.params, { title: 'title', text: 'text', url: 'url' })
  })

  test('é GET — não exige handler de POST no service worker', () => {
    // POST obrigaria o SW a interceptar e remontar o formulário. GET entrega na
    // query e a página lê de `location.search`, sem peça nova no caminho.
    assert.equal(st.method, 'GET')
  })

  test('a ação fica DENTRO do escopo do app', () => {
    // Fora do escopo, o navegador ignora o share_target em silêncio.
    assert.ok(st.action.startsWith(MANIFESTO.scope),
      `action ${st.action} precisa estar sob o scope ${MANIFESTO.scope}`)
  })

  test('quem declara é o assistente, NÃO o app principal', () => {
    // Dois manifestos declarando share_target = duas entradas "GranaEvo" na
    // folha de compartilhamento, e o usuário sem saber qual escolher.
    //
    // E há uma razão mais dura: em prod `granaevo.com/assistente` responde 307
    // para `assistente.granaevo.com`. Um share target no app principal (scope
    // "/") apontando pra cá atravessaria origem e jogaria o usuário pra fora da
    // janela do PWA instalado. Aqui a ação é same-origin, sem redirect.
    assert.ok(!/share_target/.test(VITE),
      'o manifesto do VitePWA (app principal) não pode declarar share_target')
  })
})

describe('Passo 12 — o texto compartilhado é tratado como hostil', () => {
  test('NUNCA envia sozinho — pré-preenche e espera o toque', () => {
    // O conteúdo pode ser um artigo inteiro ou uma propaganda. Enviar sozinho
    // criaria lançamento que ninguém pediu; e o usuário nem viu o que foi.
    const fn = CODIGO.match(/function receberCompartilhado\(\)[\s\S]*?\n\}/)[0]
    assert.match(fn, /UI\.focusInput\(TEXTO_COMPARTILHADO\)/)
    assert.ok(!/onSend\(/.test(fn),
      'pré-preencher é a confirmação; disparar o envio tira a decisão do usuário')
  })

  test('o texto é cortado no mesmo teto do parser', () => {
    // Um artigo compartilhado inteiro não pode virar um POST gigante.
    assert.match(CODIGO, /SHARE_MAX = 500/)
    assert.match(CODIGO, /\.slice\(0, SHARE_MAX\)/)
    const API = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/assistant-api.js'), 'utf8')
    assert.match(API, /MAX_TEXT\s*=\s*500/,
      'se o teto do assistant-api mudar, o do share precisa acompanhar')
  })

  test('a URL é limpa — o gasto não fica no histórico', () => {
    assert.match(CODIGO, /history\.replaceState\(null, '', window\.location\.pathname\)/)
  })

  test('a limpeza acontece ANTES do boot poder abortar', () => {
    // O boot desvia em três pontos (sem sessão → /login, trava por PIN
    // cancelada, falha no init). Se a limpeza morasse no consumo, lá no fim, a
    // notificação do banco — com valor e estabelecimento — ficaria na barra de
    // endereço justamente nos caminhos em que o usuário nem entrou.
    const captura = CODIGO.indexOf('const TEXTO_COMPARTILHADO = capturarCompartilhado()')
    const boot    = CODIGO.indexOf('async function boot()')
    assert.ok(captura > 0 && boot > 0)
    assert.ok(captura < boot,
      'a captura precisa rodar na avaliação do módulo, não depois do boot')
  })

  test('o texto não sobrevive à aba', () => {
    // O histórico do chat já é texto em claro (caveat D37). Um gasto que o
    // usuário ainda nem confirmou não tem por que ser gravado.
    const bloco = CODIGO.slice(CODIGO.indexOf('function capturarCompartilhado'),
                               CODIGO.indexOf('const TEXTO_COMPARTILHADO'))
    assert.ok(!/localStorage|sessionStorage/.test(bloco),
      'o texto compartilhado fica só em memória')
  })

  test('a entrada não depende do header que está fechado', () => {
    // `vercel.json` serve `web-share=()` (confirmado em prod). Esse token da
    // Permissions-Policy governa o `navigator.share()` — o compartilhamento de
    // SAÍDA. O Share Target é ENTRADA: navegação declarada no manifesto, sem
    // token de policy. Por isso funciona com o header fechado.
    //
    // A guarda é pro futuro: se alguém adicionar `navigator.share` aqui, vai
    // falhar calado em prod até liberar `web-share=(self)` no vercel.json.
    assert.ok(!/navigator\.share|navigator\.canShare/.test(CODIGO),
      'usar navigator.share exige liberar web-share=(self) no vercel.json')
    const VERCEL = readFileSync(join(RAIZ, 'vercel.json'), 'utf8')
    assert.match(VERCEL, /web-share=\(\)/,
      'se o header mudar, revisar a nota acima')
  })

  test('não engole os outros parâmetros da página', () => {
    // `?install=1` e `?pwadebug=1` continuam funcionando: a limpeza só dispara
    // quando um dos três campos de share veio junto.
    const fn = CODIGO.match(/function capturarCompartilhado\(\)[\s\S]*?\n\}/)[0]
    const antes = fn.indexOf('partes.length')
    const limpa = fn.indexOf('replaceState')
    assert.ok(antes > 0 && limpa > antes,
      'a guarda de "veio share?" precisa vir antes de mexer na URL')
  })
})
