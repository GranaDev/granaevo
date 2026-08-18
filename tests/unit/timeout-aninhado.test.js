/**
 * O TIMEOUT DE DENTRO TEM DE SER MENOR QUE O DE FORA.
 *
 * Sintoma relatado em 2026-08-18: "digita e-mail e senha corretos e carrega mais
 * de 15 segundos até entrar". Não era lentidão — era `RPC_TIMEOUT_MS = 15_000`
 * do cliente estourando.
 *
 * E o proxy (`api/user-data.js`, caminho GET) usava `AbortSignal.timeout(15_000)`,
 * o MESMO valor. Empatados, o cliente abortava no mesmo instante em que o proxy
 * desistia: o 504 nunca chegava a ser enviado e o motivo real da falha — edge
 * lenta, banco lento, rede — se perdia. O usuário via 15s de nada e o
 * desenvolvedor não via erro nenhum.
 *
 * A regra: quem está mais perto do upstream desiste PRIMEIRO, para conseguir
 * traduzir a falha antes que quem está por fora perca a paciência. Timeout
 * aninhado com valores iguais é um diagnóstico jogado fora.
 *
 * Este teste falha se alguém reequilibrar um dos dois lados sem olhar o outro.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function semComentarios(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

const num = (s) => Number(String(s).replace(/_/g, ''))

describe('timeout aninhado do carregamento', () => {
  const DM = semComentarios(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
  const PROXY = semComentarios(readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8'))

  test('o cliente declara RPC_TIMEOUT_MS', () => {
    const m = DM.match(/RPC_TIMEOUT_MS\s*=\s*([0-9_]+)/)
    assert.ok(m, 'não achei RPC_TIMEOUT_MS — o teste não pode passar por ausência')
    assert.ok(num(m[1]) > 0)
  })

  test('o proxy desiste ANTES do cliente no caminho GET', () => {
    const cliente = num(DM.match(/RPC_TIMEOUT_MS\s*=\s*([0-9_]+)/)[1])

    // Recorta o bloco do GET por DELIMITADOR, nunca por contagem de linhas:
    // o arquivo cresce e uma janela fixa apodrece.
    const i = PROXY.indexOf("if (req.method === 'GET')")
    assert.ok(i !== -1, 'não achei o bloco GET do proxy')
    const bloco = PROXY.slice(i, i + 2000)

    const m = bloco.match(/AbortSignal\.timeout\(\s*([0-9_]+)\s*\)/)
    assert.ok(m, 'o GET do proxy precisa ter um AbortSignal.timeout explícito')
    const proxy = num(m[1])

    assert.ok(
      proxy < cliente,
      `proxy=${proxy}ms precisa ser MENOR que cliente=${cliente}ms — ` +
      'com valores iguais o 504 nunca chega e a causa da falha se perde',
    )
  })

  test('a folga é suficiente para o 504 viajar', () => {
    const cliente = num(DM.match(/RPC_TIMEOUT_MS\s*=\s*([0-9_]+)/)[1])
    const i = PROXY.indexOf("if (req.method === 'GET')")
    const proxy = num(PROXY.slice(i, i + 2000).match(/AbortSignal\.timeout\(\s*([0-9_]+)\s*\)/)[1])

    assert.ok(cliente - proxy >= 2000,
      `folga de ${cliente - proxy}ms é pouca; 1s pode não bastar para a resposta atravessar Cloudflare+Vercel`)
  })
})
