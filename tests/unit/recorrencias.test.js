/**
 * GranaEvo — Testes do detector de assinaturas esquecidas
 *
 * Regressão do falso-positivo (2026-07-14): contas fixas (aluguel/luz) vazavam
 * pro detector porque a exclusão usava tipos errados ('Conta fixa'/'Cartão' vs os
 * reais 'Conta Fixa'/'Pagamento Cartão'). Como conta fixa é exatamente o padrão
 * procurado (mensal + valor estável), o aluguel aparecia como "assinatura esquecida".
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectarAssinaturasEsquecidas, deveMostrarAviso } from '../../src/scripts/modules/recorrencias.js'

const HOJE = new Date(2026, 6, 15) // 15/07/2026

describe('detectarAssinaturasEsquecidas — falso-positivo de conta fixa (o bug)', () => {
  test('aluguel mensal (Conta Fixa) NÃO é "assinatura esquecida"', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1500, data: '10/05/2026' },
      { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1500, data: '10/06/2026' },
      { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1500, data: '10/07/2026' },
    ]
    // Sem o fix, isto casava TODOS os critérios (gaps 30/31d, valor estável, recente).
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })

  test('pagamento de fatura recorrente NÃO é "assinatura esquecida"', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f1', descricao: 'Nubank', valor: 800, data: '10/05/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f2', descricao: 'Nubank', valor: 800, data: '10/06/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f3', descricao: 'Nubank', valor: 800, data: '10/07/2026' },
    ]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })

  test('exclusão funciona pelo marcador de origem mesmo com tipo inesperado', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Rótulo Novo', contaFixaId: 'c9', descricao: 'Internet', valor: 120, data: '10/05/2026' },
      { categoria: 'saida', tipo: 'Rótulo Novo', contaFixaId: 'c9', descricao: 'Internet', valor: 120, data: '10/06/2026' },
      { categoria: 'saida', tipo: 'Rótulo Novo', contaFixaId: 'c9', descricao: 'Internet', valor: 120, data: '10/07/2026' },
    ]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })
})

describe('detectarAssinaturasEsquecidas — detecção verdadeira', () => {
  test('cobrança mensal estável não registrada É detectada, com custo anual', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '12/05/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '11/06/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '11/07/2026' },
    ]
    const r = detectarAssinaturasEsquecidas(txs, [], HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].valorMensal, 39.9)
    assert.equal(r[0].valorAnual, 478.8, 'o "susto" anual é o valor da feature')
    assert.equal(r[0].ocorrencias, 3)
  })

  test('assinatura já registrada não aparece como esquecida', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '12/05/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '11/06/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix', valor: 39.90, data: '11/07/2026' },
    ]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [{ nome: 'Netflix', ativa: true }], HOJE), [])
  })
})

describe('detectarAssinaturasEsquecidas — critérios conservadores', () => {
  test('cobrança antiga (>45 dias sem cobrar) não conta como ativa', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Spotify', valor: 21.90, data: '01/03/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Spotify', valor: 21.90, data: '31/03/2026' },
    ]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })

  test('valor instável (mercado) não é assinatura', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado', valor: 100, data: '12/05/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado', valor: 400, data: '11/06/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado', valor: 250, data: '11/07/2026' },
    ]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })

  test('ocorrência única não vira assinatura', () => {
    const txs = [{ categoria: 'saida', tipo: 'Lazer', descricao: 'Cinema', valor: 45, data: '11/07/2026' }]
    assert.deepEqual(detectarAssinaturasEsquecidas(txs, [], HOJE), [])
  })
})

describe('deveMostrarAviso — regra do card proativo no dashboard', () => {
  const AGORA = HOJE.getTime()
  const DIA = 86_400_000
  const achados = [{ nome: 'Netflix', valorAnual: 478.8 }]

  test('sem achados → não mostra (não polui o dashboard de quem está ok)', () => {
    assert.equal(deveMostrarAviso([], 0, AGORA), false)
    assert.equal(deveMostrarAviso(null, 0, AGORA), false)
  })

  test('com achados e nunca dispensado → mostra', () => {
    assert.equal(deveMostrarAviso(achados, 0, AGORA), true)
    assert.equal(deveMostrarAviso(achados, null, AGORA), true)
  })

  test('dispensado há 5 dias → fica quieto (não vira nag)', () => {
    assert.equal(deveMostrarAviso(achados, AGORA - 5 * DIA, AGORA), false)
  })

  test('dispensado há 40 dias → volta a perguntar', () => {
    assert.equal(deveMostrarAviso(achados, AGORA - 40 * DIA, AGORA), true)
  })

  test('valor de dispensa corrompido não trava o card', () => {
    assert.equal(deveMostrarAviso(achados, NaN, AGORA), true)
    assert.equal(deveMostrarAviso(achados, 'lixo', AGORA), true)
  })
})
