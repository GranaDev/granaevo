/**
 * 38.2 — a exportação de dados estava furada, e é o entregável da portabilidade.
 *
 * RELATADO PELO DONO (2026-08-04), abrindo o próprio arquivo:
 *   · não existe aba "Transações" — o dado principal dele
 *   · "Perfis" mostra "—" em vez dos nomes
 *   · "Atividade" traz ~500 linhas de "UPDATE / data"
 *
 * O primeiro e o segundo tinham UMA causa só, e ela não estava na planilha:
 * `_buscarBlob()` devolve a RESPOSTA da API — `{success, data_json, ...}` — e o
 * montador lia `blob.profiles`, que não existe nesse nível. O `??` caía no
 * envelope inteiro, `dados_financeiros` virava um objeto em vez de lista, e a
 * planilha (que checa `Array.isArray`) montava ZERO abas de dados.
 *
 * Não aparecia como erro em lugar nenhum: o arquivo era gerado, baixava, abria.
 * Só estava vazio — que é o pior jeito de falhar num direito da LGPD (art. 18, V).
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { montarPlanilha, celula } from '../../src/scripts/modules/export-planilha.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const EXPORT = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/export-dados.js'), 'utf8'))

// A forma REAL da resposta de `/api/user-data`.
const respostaDaApi = {
  success: true,
  conta: 'ba350891-7771-4a78-94cf-273b9ddf606b',
  versao: '2026-08-07T22:46:05Z',
  data_json: {
    version: '1.0',
    profiles: [
      { id: 'p1', nome: 'Lucas', transacoes: [{ id: 't1', categoria: 'saida', valor: 50, descricao: 'Feira' }], metas: [{ id: 'm1', descricao: 'Viagem', saved: 100 }] },
      { id: 'p2', nome: 'Ke', transacoes: [{ id: 't2', categoria: 'entrada', valor: 70 }], metas: [] },
    ],
  },
}

const abasDe = (df, meta = {}) =>
  montarPlanilha({ dados_financeiros: df, conta: { email: 'x@y.com' }, metadados_da_conta: meta })

const doResumo = (abas, rotulo) => {
  const r = abas.find((a) => a.nome === 'Resumo')
  return r?.linhas.find((l) => l[0]?.v === rotulo)?.[1]?.v ?? null
}

describe('⭐ a causa raiz: o caminho até os perfis', () => {
  test('o montador lê `data_json.profiles`, não `profiles`', () => {
    assert.match(EXPORT, /dados_financeiros: blob\?\.data_json\?\.profiles \?\? blob\?\.profiles \?\? null/)
  })

  test('com a resposta REAL da API, as abas de dados aparecem', () => {
    const abas = abasDe(respostaDaApi?.data_json?.profiles ?? respostaDaApi?.profiles ?? null)
    const nomes = abas.map((a) => a.nome)
    assert.ok(nomes.includes('Transações'), 'a aba principal do usuário')
    assert.ok(nomes.includes('Metas'))
  })

  test('e o campo Perfis traz os nomes', () => {
    const abas = abasDe(respostaDaApi.data_json.profiles)
    assert.equal(doResumo(abas, 'Perfis'), 'Lucas · Ke')
  })

  test('⚠️ lendo pelo caminho ANTIGO, o arquivo sai VAZIO — e sem erro nenhum', () => {
    // É a reprodução do defeito. Serve de âncora: se alguém "simplificar" o
    // caminho de volta, este teste mostra o que acontece.
    const errado = respostaDaApi?.profiles ?? respostaDaApi ?? null
    const abas = abasDe(errado)
    assert.deepEqual(abas.map((a) => a.nome), ['Resumo'], 'nenhuma aba de dados')
    assert.equal(doResumo(abas, 'Perfis'), '—')
  })

  test('perfil com `name` em vez de `nome` também é reconhecido', () => {
    // Perfis antigos usam `name`. Ler só `nome` devolveria "—" de novo.
    const abas = abasDe([{ id: 'p1', name: 'Antigo', transacoes: [{ id: 't', valor: 1 }] }])
    assert.equal(doResumo(abas, 'Perfis'), 'Antigo')
  })
})

describe('38.2c — o diário do sistema virou uma linha legível', () => {
  test('não existe mais aba "Atividade"', () => {
    // 500 pares "UPDATE / data" não são o dado do titular: são o diário interno
    // do sistema. A LGPD dá direito ao dado da pessoa.
    const abas = abasDe(respostaDaApi.data_json.profiles, {
      registro_de_atividade: { total: 23280, ultima: '2026-08-07T22:46:05Z' },
    })
    assert.ok(!abas.some((a) => a.nome === 'Atividade'))
  })

  test('mas a transparência fica: contagem e data da última', () => {
    const abas = abasDe(respostaDaApi.data_json.profiles, {
      registro_de_atividade: { total: 23280, ultima: '2026-08-07T22:46:05Z' },
    })
    assert.match(String(doResumo(abas, 'Gravações')), /^23280 gravação\(ões\) · última em \d{2}\/\d{2}\/\d{4}$/)
  })

  test('sem o dado, a linha simplesmente não aparece', () => {
    const abas = abasDe(respostaDaApi.data_json.profiles, {})
    assert.equal(doResumo(abas, 'Gravações'), null)
  })

  test('a consulta pega a CONTAGEM sem baixar as linhas', () => {
    // `head: true` evita trazer 23 mil registros para exibir um número.
    assert.match(EXPORT, /count: 'exact', head: true/)
    assert.match(EXPORT, /\.limit\(1\)/)
    assert.ok(!/financial_audit_log[\s\S]{0,120}limit\(500\)/.test(EXPORT))
  })
})

describe('o que a exportação promete e não pode quebrar', () => {
  test('o Resumo continua dizendo que não há credencial no arquivo', () => {
    const abas = abasDe(respostaDaApi.data_json.profiles)
    const txt = JSON.stringify(abas.find((a) => a.nome === 'Resumo').linhas)
    assert.match(txt, /carrega seus DADOS, não seu ACESSO/)
    assert.match(txt, /privacidade@granaevo\.com/)
  })

  test('as duas saídas vêm do MESMO pacote', () => {
    // Se JSON e planilha coletassem separado, um dos dois estaria mentindo
    // sobre o que a empresa guarda.
    assert.match(EXPORT, /montarPlanilha\(pacote\)/)
    assert.match(EXPORT, /function _montar\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2 (2026-08-09) — o que o dono encontrou ao abrir a planilha de verdade.
// ─────────────────────────────────────────────────────────────────────────────
describe('⭐ nada de JSON cru dentro de uma célula', () => {
  const META = {
    nome: 'Emergência', saved: 949,
    monthly: { '2026-08': 949 },
    historicoRetiradas: [
      { data: '07/08/2026', valor: 50, motivo: 'Outro', saldoAnterior: 1500, saldoPosterior: 1450 },
      { data: '08/08/2026', valor: 500, motivo: 'Retirada pela tela de Transações', saldoAnterior: 1449, saldoPosterior: 949 },
    ],
  }
  const PACOTE = { dados_financeiros: [{ nome: 'Userteste', metas: [META] }] }
  const abas = montarPlanilha(PACOTE)
  const texto = (aba) => aba.linhas.map((l) => l.map((c) => String(c?.v ?? c)).join('|')).join('\n')

  test('o mapa mês→valor vira "08/2026: R$ 949,00"', () => {
    // Era {"2026-08":949} dentro da célula.
    //
    // ⚠️ Compara com o espaço NORMALIZADO: `toLocaleString('pt-BR')` põe um
    // espaço NÃO-QUEBRÁVEL (U+00A0) entre "R$" e o número. Escrever a string à
    // mão dá um teste que falha mostrando duas linhas idênticas na tela — e o
    // próximo a ler perde meia hora achando que é bug do assert.
    const semNbsp = (s) => String(s).replace(/ /g, ' ')
    assert.equal(semNbsp(celula('monthly', META.monthly).v), '08/2026: R$ 949,00')
  })

  test('a lista de retiradas não despeja o array na célula', () => {
    const c = celula('historicoRetiradas', META.historicoRetiradas)
    assert.equal(c.v, '2 registro(s)')
    assert.ok(!/[[{]/.test(c.v), 'nenhum colchete/chave de JSON sobrou')
  })

  test('⭐ nenhuma célula da planilha contém JSON', () => {
    // A CONDIÇÃO, não o caso: qualquer campo aninhado que alguém acrescentar ao
    // app cai aqui antes de chegar ao usuário.
    for (const aba of abas) {
      for (const linha of aba.linhas) {
        for (const c of linha) {
          const v = String(c?.v ?? c)
          assert.ok(!/^\s*[[{]/.test(v), `JSON cru na aba ${aba.nome}: ${v}`)
        }
      }
    }
  })

  test('as retiradas ganham ABA própria, com uma linha por retirada', () => {
    const r = abas.find((a) => a.nome === 'Retiradas')
    assert.ok(r, 'a aba Retiradas precisa existir')
    assert.equal(r.linhas.length, 3, 'cabeçalho + 2 retiradas')
    const t = texto(r)
    assert.match(t, /Emergência/)
    assert.match(t, /Retirada pela tela de Transações/)
    assert.match(t, /Saldo anterior/)
  })

  test('sem retiradas, a aba não aparece vazia', () => {
    const semNada = montarPlanilha({ dados_financeiros: [{ nome: 'X', metas: [{ nome: 'M' }] }] })
    assert.equal(semNada.find((a) => a.nome === 'Retiradas'), undefined)
  })

  test('as colunas de dinheiro do histórico saem formatadas', () => {
    // Anteriormente `saldoAnterior`/`saldoPosterior`/`saved` caíam fora do
    // EH_DINHEIRO (ancorado em "saldo" exato) e saíam como número cru.
    for (const k of ['saldoAnterior', 'saldoPosterior', 'saved', 'valor']) {
      assert.equal(typeof celula(k, 1450), 'object', `${k} devia ter estilo de dinheiro`)
    }
  })
})

describe('⭐ a planilha não mostra id interno — mas não perde a ligação', () => {
  // Decisão do dono (2026-08-09): a aba Transações trazia SEIS colunas de UUID
  // e nenhuma diz nada a quem abre o arquivo para conferir o mês.
  //
  // A LGPD não é afetada: o JSON é que cumpre a portabilidade (art. 18, V) e
  // segue com todos os ids. A planilha é para LER.
  const PACOTE = {
    dados_financeiros: [{
      nome: 'X', id: 'p1',
      transacoes: [
        { id: 't1', data: '01/08', descricao: 'Retirada: Viagem', valor: 50, categoria: 'retirada_reserva', metaId: 'm1' },
        { id: 't2', data: '02/08', descricao: 'Parcela tênis', valor: 99, categoria: 'saida_credito', cartaoId: 'c1', faturaId: 'f1', compraId: 'x9', contaFixaId: 'cf1' },
      ],
      metas: [{ id: 'm1', nome: 'Viagem', saved: 100 }],
      cartoesCredito: [{ id: 'c1', nomeBanco: 'Nubank', limite: 1000 }],
      contasFixas: [{ id: 'cf1', nome: 'Luz', valor: 120, cartaoId: 'c1' }],
    }],
  }
  const abas = montarPlanilha(PACOTE)
  const cabecalho = (n) => abas.find((a) => a.nome === n).linhas[0].map((c) => String(c?.v ?? c))
  const corpo = (n) => abas.find((a) => a.nome === n).linhas.slice(1)
    .map((l) => l.map((c) => String(c?.v ?? c)))

  test('⭐ nenhuma aba tem coluna de id — a CONDIÇÃO, não o caso', () => {
    // Campo novo terminado em Id cai aqui antes de chegar ao usuário.
    for (const aba of abas) {
      if (aba.nome === 'Resumo') continue     // o Resumo é texto corrido, não tabela
      for (const h of aba.linhas[0].map((c) => String(c?.v ?? c))) {
        assert.ok(!/^id$|\bid$/i.test(h), `coluna de id sobrou na aba ${aba.nome}: "${h}"`)
      }
    }
  })

  test('⭐ e nenhuma CÉLULA carrega um id disfarçado de valor', () => {
    // Tirar o cabeçalho e deixar o UUID no corpo seria trocar de lugar, não resolver.
    for (const aba of abas) {
      if (aba.nome === 'Resumo') continue
      for (const linha of aba.linhas.slice(1)) {
        for (const c of linha) {
          const v = String(c?.v ?? c)
          assert.ok(!/^(t\d|m\d|c\d|cf\d|f\d|x\d|p\d)$/.test(v), `id cru numa célula de ${aba.nome}: "${v}"`)
        }
      }
    }
  })

  test('a referência vira NOME — a informação não se perde', () => {
    const h = cabecalho('Transações')
    for (const col of ['Reserva', 'Cartão', 'Conta fixa']) {
      assert.ok(h.includes(col), `faltou a coluna ${col}`)
    }
    const linhas = corpo('Transações')
    assert.ok(linhas[0].includes('Viagem'), 'a retirada precisa dizer de qual reserva saiu')
    assert.ok(linhas[1].includes('Nubank'), 'a compra precisa dizer em qual cartão foi')
  })

  test('referência órfã não vira coluna vazia', () => {
    // Um metaId apontando para meta apagada não pode criar uma coluna "Reserva"
    // em branco na aba inteira.
    const orfa = montarPlanilha({ dados_financeiros: [{ nome: 'X',
      transacoes: [{ id: 't1', data: '01/08', descricao: 'x', valor: 1, metaId: 'sumiu' }], metas: [] }] })
    const h = orfa.find((a) => a.nome === 'Transações').linhas[0].map((c) => String(c?.v ?? c))
    assert.ok(!h.includes('Reserva'))
  })
})
