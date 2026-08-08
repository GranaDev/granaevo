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

import { montarPlanilha } from '../../src/scripts/modules/export-planilha.js'

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
