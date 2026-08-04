/**
 * Passo 8 — os stubs que aliviam o `vendor-supabase`, a maior peça do boot.
 *
 * O `supabase-js` importa realtime-js, storage-js e functions-js ESTATICAMENTE
 * no topo do seu index.mjs. Import estático entra no bundle mesmo que nada o
 * execute — então os três viajavam no boot. Dois deles nunca são usados por
 * este app; o terceiro é.
 *
 * Este arquivo existe porque a diferença entre "não usado" e "usado" aqui é a
 * diferença entre −15 KB e as fotos de perfil pararem de carregar. Um stub a
 * mais quebra produção em silêncio: o alias resolve, o build passa verde, e só
 * o usuário descobre.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Todos os .js sob um diretório, recursivo. Sem depender de grep do sistema. */
function varrer(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...varrer(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VITE = readFileSync(join(RAIZ, 'vite.config.js'), 'utf8')
const SDK  = readFileSync(join(RAIZ, 'node_modules/@supabase/supabase-js/dist/index.mjs'), 'utf8')

describe('o que É stubado, e por quê', () => {
  test('realtime e functions estão aliasados', () => {
    assert.match(VITE, /'@supabase\/realtime-js':\s*path\.resolve/)
    assert.match(VITE, /'@supabase\/functions-js':\s*path\.resolve/)
  })

  test('⚠️ STORAGE NÃO pode ser stubado — está EM USO', () => {
    // `supabase.storage.from('profile-photos').createSignedUrl()` gera a URL
    // assinada da foto de perfil. O roadmap do Passo 8 afirmava "0 arquivos com
    // .storage." — era FALSO, e stubar teria quebrado as fotos em produção.
    const DASH = readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8')
    assert.match(DASH, /supabase\.storage\s*\n?\s*\.from\('profile-photos'\)/)
    assert.ok(!/'@supabase\/storage-js'/.test(VITE),
      'storage-js está em uso — aliasar quebra a foto de perfil')
  })

  test('nenhum código do app chama functions.invoke', () => {
    // A premissa do stub. Edge Functions são chamadas pelos proxies em api/,
    // server-side com PROXY_SECRET — nunca pelo cliente.
    const culpados = []
    for (const arq of varrer(join(RAIZ, 'src'))) {
      // Os stubs citam a API que substituem — inclusive na mensagem de erro que
      // ensina a reverter. Varrer a própria vendor/ acusaria o remédio.
      if (arq.includes(join('scripts', 'vendor'))) continue
      const src = readFileSync(arq, 'utf8')
      // Ignora comentários: este projeto explica o próprio código nos comentários.
      const codigo = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
      if (/\.functions\s*\.\s*invoke|supabase\.functions\b/.test(codigo)) culpados.push(arq)
    }
    assert.deepEqual(culpados, [],
      'alguém passou a chamar supabase.functions — o stub lança, e o build não avisa')
  })
})

describe('os stubs cobrem exatamente o que o SDK importa', () => {
  const importados = (pkg) => {
    const m = SDK.match(new RegExp(`import \\{([^}]+)\\} from "@supabase/${pkg}"`))
    assert.ok(m, `o supabase-js parou de importar ${pkg} — revisar o alias`)
    return m[1].split(',').map((s) => s.trim()).filter(Boolean).sort()
  }
  const exportados = (arq) => {
    const src = readFileSync(join(RAIZ, 'src/scripts/vendor', arq), 'utf8')
    return [...src.matchAll(/export (?:class|const|function) (\w+)/g)].map((m) => m[1]).sort()
  }

  test('functions-stub exporta os 6 nomes que o SDK pede', () => {
    // Faltando um, o build quebra com "does not provide an export named".
    // Sobrando, é código morto. A igualdade é o contrato.
    assert.deepEqual(exportados('functions-stub.js'), importados('functions-js'))
  })

  test('o FunctionsClient do stub GRITA se for construído', () => {
    // O getter `functions` do SupabaseClient é preguiçoso: nada instancia isto
    // hoje. Se alguém passar a usar, tem que quebrar alto, com o motivo escrito
    // — não devolver um objeto que finge funcionar e falha calado na rede.
    const src = readFileSync(join(RAIZ, 'src/scripts/vendor/functions-stub.js'), 'utf8')
    const cls = src.match(/export class FunctionsClient[\s\S]*?\n\}/)[0]
    assert.match(cls, /throw new Error/)
    assert.match(cls, /vite\.config\.js/, 'a mensagem precisa dizer como reverter')
  })

  test('o getter de functions no SDK continua preguiçoso', () => {
    // É a premissa de segurança do stub. Se virar instanciação no construtor
    // (como o realtime), o stub passa a quebrar TODO boot.
    assert.match(SDK, /get functions\(\)/)
  })
})

describe('a versão do SDK está pinada — os stubs dependem disso', () => {
  test('supabase-js sem ^ nem ~', () => {
    // Os stubs cobrem os nomes que ESTA versão importa. Um minor novo pode
    // importar outro símbolo e quebrar o build — pinar é o que dá o aviso.
    const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'))
    assert.match(pkg.dependencies['@supabase/supabase-js'], /^\d+\.\d+\.\d+$/)
  })

  test('o orçamento tranca o ganho', () => {
    // 34,3 KB hoje. Teto 36: barra a volta do realtime (~48,6) E a do
    // functions-js sozinho (35,1) — que com o teto antigo de 40 passaria batido.
    const SZ = readFileSync(join(RAIZ, 'scripts/check-bundle-size.mjs'), 'utf8')
    const m = SZ.match(/'vendor-supabase\.js':\s*(\d+)/)
    assert.ok(m && Number(m[1]) <= 36, 'teto frouxo deixa a regressão passar')
  })
})
