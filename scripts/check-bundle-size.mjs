// scripts/check-bundle-size.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Guard de tamanho de bundle (BLINDAGEM de performance).
// Roda no `postbuild`: mede o gzip de cada asset crítico do dist/ e falha
// (exit 1) se algum estourar o orçamento. Impede que CSS/JS morto volte a
// crescer silenciosamente — análogo ao /god-eyes, mas para peso de página.
//
// Para ajustar um teto, edite BUDGETS_KB abaixo. Mantenha ~15% de folga.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist', 'assets');

// Orçamentos por PREFIXO de arquivo (sem hash), em KB de gzip.
const BUDGETS_KB = {
  'dashboard.css':       66,   // tela do pagante — alvo principal
  // 42 (2026-07-08): +9 conquistas no engine estatico (predicados) + sanitizadores
  // de config/desafios no load path. Recursos novos (radar/previsao/desafios/
  // horas-vida/simulador/recorrencias) sao TODOS chunks lazy — nao pesam aqui.
  // Passo 10 (2026-07-18): 41,1 → 39,0 KB extraindo o painel de alertas para um
  // chunk lazy. Orçamento baixado 42 → 40 DE PROPÓSITO: da última vez o ganho do
  // Passo 10 foi silenciosamente reocupado por features novas até voltar a 98%.
  // Com 40, quem estourar é obrigado a lazy-ar em vez de engordar o boot.
  //
  // 40 → 42 (2026-08-07). O guarda funcionou: reprovou o build da Vercel em
  // 40,0/40 e me obrigou a adiar tudo que dava. Foi adiado, nesta ordem:
  //   · a lógica de tempo real (filtro de perfil, adiamento com formulário
  //     aberto, diagnóstico) saiu do dashboard para tempo-real.js — que já é
  //     carregado sob demanda;
  //   · `diff-registros.js` virou `import()` dentro do data-manager: ele só é
  //     preciso no primeiro SAVE, bem depois da primeira pintura (chunk de
  //     1,05 KB gzip);
  //   · o realtime-js entrou como chunk próprio (`vendor-realtime`), e NÃO no
  //     vendor-supabase — o teto de 36 lá pegou essa tentativa.
  // Também MEDIDO e descartado: extrair data-manager+diff+registro-id para um
  // chunk `core-dados`. O dashboard caía para 36,9, mas o chunk saía com 40,7 —
  // o boot ia de 40,0 para 77,6 KB. Está anotado no vite.config para ninguém
  // repetir.
  //
  // O que sobrou no boot é o CAMINHO DE SAVE do Passo 37 (identidade dos
  // registros + derivação das operações). Ele roda em toda gravação e não tem
  // como ser adiado sem atrasar o save do usuário.
  //
  // ⚠️ Segunda vez que este teto é elevado, e a nota de 2026-07-18 previu
  // exatamente isso. O conserto de verdade é o PASSO 10 (quebrar o monólito dashboard.js),
  // que deixa de ser opcional: com 42 não há espaço para mais nenhuma feature no
  // boot. A próxima que precisar de espaço aqui divide o arquivo antes.
  'dashboard.js':        42,
  // Passo 8: realtime-js E functions-js stubados → 34,3 KB. O teto era 40, e 40
  // só pegava a volta do realtime (~48,6). A volta do functions-js sozinho daria
  // 35,1 — passaria despercebida. 36 dá 1,7 KB de folga e barra as duas.
  'vendor-supabase.js':  36,
  // 40 → 43 (2026-07-22): reforma editorial das exportações (PDF/slides).
  // 43 → 41 (2026-07-23): gerarXlsx virou import() dinâmico (chunk xlsx-*.js).
  // 41 → 30 (2026-07-23): as 4 funções de export (PDF/CSV/Excel/slides) + helpers
  // só-de-export saíram para db-relatorios-export.js, carregado sob demanda no
  // clique. db-relatorios caiu 38,5 → 27,6 — MAIS LEVE que os 40 originais. Teto
  // agora bem abaixo do ponto de partida. Polimentos de export (ex.: CSV) caem no
  // chunk de export, não aqui.
  'db-relatorios.js':    30,
  // Sub-chunk lazy das exportações (só baixa no clique de exportar). Teto folgado
  // porque está fora do caminho crítico; ainda assim trava crescimento silencioso.
  'db-relatorios-export.js': 16,
  'main.css':            14,
  'convidados.css':      20,
};

function gzipKB(file) {
  return gzipSync(readFileSync(file)).length / 1024;
}

// Casa cada arquivo do dist com seu prefixo de orçamento (ignora o -hash).
//
// ⚠️ CONSERTO 2026-08-10 — o guard media o ARQUIVO ERRADO, em silêncio.
// O casamento era `startsWith(base + '-') && endsWith(ext)`, e
// `db-relatorios-export-CDZ9Lehn.js` satisfaz os dois para o orçamento de
// `db-relatorios.js`. Quem vencia dependia da ORDEM do readdir, que muda com o
// hash: naquele build o orçamento de 30 KB estava sendo conferido contra um
// arquivo de 12,0 KB, enquanto o db-relatorios real tinha 27,7 KB (92%).
// Verde que não prova nada — o teto podia estourar e ninguém saberia.
//
// A trava agora é o formato do hash do Vite: EXATAMENTE 8 caracteres de
// [A-Za-z0-9_-] entre o `-` e a extensão. (O hash pode conter `-`, como em
// `db-relatorios-D-_VZJA2.css`, então "sem traço" não serviria de regra.)
// E ambiguidade agora REPROVA em vez de escolher sozinha.
const files = readdirSync(DIST);
let failed = false;
const rows = [];

const RE_HASH = /^[A-Za-z0-9_-]{8}$/;

for (const [prefix, budget] of Object.entries(BUDGETS_KB)) {
  const dot = prefix.lastIndexOf('.');
  const base = prefix.slice(0, dot);          // ex.: "dashboard"
  const ext  = prefix.slice(dot);             // ex.: ".css"
  const candidatos = files.filter(f =>
    f.startsWith(base + '-') && f.endsWith(ext) &&
    RE_HASH.test(f.slice(base.length + 1, f.length - ext.length))
  );
  if (candidatos.length > 1) {
    failed = true;
    rows.push(`  ❌ ${prefix.padEnd(22)} AMBÍGUO: ${candidatos.join(', ')}`);
    continue;
  }
  const match = candidatos[0];
  // Orçamento sem arquivo é orçamento morto ou build quebrado — reprova.
  if (!match) { failed = true; rows.push(`  ❌ ${prefix.padEnd(22)} não encontrado no dist`); continue; }
  const kb = gzipKB(join(DIST, match));
  const over = kb > budget;
  if (over) failed = true;
  const pct = Math.round((kb / budget) * 100);
  rows.push(`  ${over ? '❌' : '✅'} ${prefix.padEnd(22)} ${kb.toFixed(1).padStart(6)} KB / ${budget} KB  (${pct}%)`);
}

console.log('\n📦 Bundle budget (gzip):');
console.log(rows.join('\n'));

if (failed) {
  console.error('\n❌ Orçamento de bundle estourado. Reduza o asset ou ajuste BUDGETS_KB em scripts/check-bundle-size.mjs (com justificativa).');
  process.exit(1);
}
console.log('\n✅ Todos os assets dentro do orçamento.\n');
