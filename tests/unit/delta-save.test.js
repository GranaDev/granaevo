/**
 * DELTA SAVE — mandar a mudança, não o mundo.
 *
 * Medido em produção (financial_audit_log, 60 dias, 6.265 saves): o blob gravado
 * tem em média 38.208 bytes e a variação média de tamanho por save é de 293
 * bytes. O payload que subia era ~130× maior que a mudança que carregava — e
 * subia três vezes (browser → Vercel → Edge) antes de virar um UPDATE.
 *
 * A máquina para evitar isso já existia (`ops_somente`, usada pela fila de
 * reenvio do 37.4). Este passo a liga no caminho feliz.
 *
 * O QUE ESTE ARQUIVO PROTEGE — as duas coisas que, se caírem, transformam uma
 * economia de banda em perda de dado:
 *
 *   1. `ops_somente` só pode sair quando o CONJUNTO de perfis não mudou. Com
 *      essa marca o servidor pula a checagem de conjunto (ela não se aplica a um
 *      reenvio, que não traz `profiles` para comparar). Operações não sabem criar
 *      nem apagar perfil: sem a guarda do cliente, um perfil criado ou removido
 *      sumiria em silêncio.
 *
 *   2. Uma recusa do servidor (409 OPS_NAO_APLICADAS) tem de virar reenvio com
 *      estado inteiro. Antes, operação que não aplicava caía sozinha no caminho
 *      de estado inteiro e o save passava. Economizar banda não pode custar essa
 *      garantia.
 *
 * Verificação sobre o FONTE (o data-manager depende de window e de rede), com o
 * cuidado que já custou caro aqui antes: comentário é removido ANTES de casar,
 * senão a própria prosa que explica a regra faz o teste passar sozinho.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Tira comentários de linha e de bloco — o teste fala do CÓDIGO, não da prosa. */
function semComentarios(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

/**
 * Recorta um bloco pelo seu DELIMITADOR, nunca por contagem de caracteres.
 * Janela fixa (`slice(i, i+4000)`) apodrece: basta o arquivo engordar para o
 * teste reprovar sem que nada tenha quebrado.
 */
function bloco(src, inicio, fim) {
  const i = src.indexOf(inicio)
  assert.ok(i !== -1, `não achei o início do bloco: ${inicio}`)
  const j = src.indexOf(fim, i)
  assert.ok(j > i, `não achei o fim do bloco: ${fim}`)
  return src.slice(i, j)
}

const DM_BRUTO = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')
const DM = semComentarios(DM_BRUTO)

const EDGE = semComentarios(
  readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8'),
)

describe('delta save — o payload deixa de carregar o estado inteiro', () => {
  test('o corpo do save envia `profiles: []` quando decide mandar só operações', () => {
    const payload = bloco(DM, 'const dataToSave = {', 'let serialized')
    assert.match(
      payload,
      /profiles:\s*soOps\s*\?\s*\[\]\s*:\s*safeProfiles/,
      'o payload voltou a mandar o estado inteiro incondicionalmente',
    )
    assert.match(
      payload,
      /ops_somente:\s*true/,
      '`ops_somente` sumiu do payload — sem ela o servidor leria `profiles: []` como exclusão',
    )
  })

  test('`soOps` EXIGE que o conjunto de perfis esteja intacto', () => {
    const decisao = bloco(DM, 'const soOps =', 'const dataToSave')
    assert.match(
      decisao,
      /conjuntoIntacto/,
      'a guarda de conjunto saiu da decisão: perfil criado ou apagado sumiria em silêncio',
    )
    assert.match(decisao, /sombra\.completo/,
      'sem `completo` as operações não descrevem tudo que mudou')
    assert.match(decisao, /this\.#retrato\.size\s*>\s*0/,
      'sem retrato não há base contra a qual as operações façam sentido')
  })

  test('a comparação de conjunto olha os DOIS sentidos (nasceu e sumiu)', () => {
    // Em 2026-08-15 o cálculo subiu para ANTES do pulo de save vazio e passou a
    // se chamar `mesmoConjunto` — porque o pulo precisa da mesma resposta. O que
    // este teste protege não mudou: os dois sentidos.
    const calc = bloco(DM, 'const mesmoConjunto =', 'if (sombra.completo')
    assert.match(calc, /this\.#retrato\.size\s*===\s*idsDoSave\.size/,
      'sem comparar o tamanho, um perfil NOVO passaria como conjunto intacto')
    assert.match(calc, /every\(/,
      'sem varrer o retrato, um perfil REMOVIDO passaria como conjunto intacto')
    // E o alias tem de continuar apontando para o mesmo cálculo: duas cópias da
    // regra divergem, e é ela que decide se uma remoção chega ao servidor.
    assert.match(DM, /const conjuntoIntacto = mesmoConjunto;/)
  })
})

describe('delta save — recusa do servidor não pode virar edição perdida', () => {
  test('409 OPS_NAO_APLICADAS reenvia com o estado inteiro', () => {
    const trecho = bloco(DM, "if (saveResp.status === 409)", 'if (!saveResp.ok)')
    assert.match(trecho, /OPS_NAO_APLICADAS/,
      'o cliente parou de reconhecer a recusa de operações')
    assert.match(
      trecho,
      /dataToSave\.profiles\s*=\s*safeProfiles/,
      'o reenvio não repõe o estado inteiro — o save do usuário se perderia',
    )
    assert.match(
      trecho,
      /delete\s+dataToSave\.ops_somente/,
      'sem tirar `ops_somente`, o reenvio seria recusado de novo pelo mesmo motivo',
    )
  })

  test('a trava de versão é conferida TAMBÉM na resposta do reenvio', () => {
    const trecho = bloco(DM, 'const versaoConflitou', 'if (!saveResp.ok)')
    const checagens = trecho.match(/versaoConflitou\(saveResp\)/g) ?? []
    assert.ok(
      checagens.length >= 2,
      'o 409 de versão só é conferido na 1ª resposta; o reenvio com estado ' +
      'inteiro é justamente o que pode trombar com a trava e voltaria como erro genérico',
    )
  })
})

describe('delta save — o contrato do servidor continua de pé', () => {
  test('a Edge recusa (409) em vez de cair no caminho de estado inteiro', () => {
    const trecho = bloco(EDGE, 'if (opsSomente && !viaOperacoes)', 'if (!viaOperacoes && touched')
    assert.match(trecho, /409/,
      'o contrato "aplique ou recuse" caiu: `profiles: []` poderia virar exclusão da conta')
    assert.match(trecho, /OPS_NAO_APLICADAS/,
      'o código da recusa mudou — o cliente não saberia reenviar')
  })

  test('o payload grande demais volta ao estado inteiro, não perde as operações', () => {
    const trecho = bloco(DM, 'if (serialized.length > MAX_PAYLOAD_BYTES && ', 'if (serialized.length > MAX_PAYLOAD_BYTES)')
    assert.match(
      trecho,
      /dataToSave\.profiles\s*=\s*safeProfiles/,
      'com `ops_somente`, descartar a sombra deixaria `profiles: []` sem operação ' +
      'nenhuma — o servidor recusaria e o save se perderia',
    )
  })
})
