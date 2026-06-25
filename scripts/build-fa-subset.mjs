// scripts/build-fa-subset.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gera um subset do Font Awesome contendo APENAS os ícones realmente usados
// no código-fonte (.html/.js), a partir do CSS oficial do pacote npm — assim
// os unicodes vêm da fonte, sem mapeamento manual sujeito a erro.
//
// Roda automaticamente no `prebuild` (nunca fica desatualizado).
// O app usa somente o peso `solid` (fas), então apenas fa-solid-900.woff2
// é embarcado. Ícones de nome dinâmico (fa-${var}) entram via SAFELIST abaixo.
//
// Reduz dashboard.css removendo ~1800 regras de glifo não usadas.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import subsetFont from 'subset-font';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const FA_DIR    = join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free');
const FA_CSS    = join(FA_DIR, 'css', 'all.min.css');
const FA_WOFF2  = join(FA_DIR, 'webfonts', 'fa-solid-900.woff2');

const OUT_CSS   = join(ROOT, 'src', 'styles', 'vendor', 'fontawesome-subset.css');
const OUT_FONTS = join(ROOT, 'public', 'assets', 'fonts');
const FONT_URL  = '/assets/fonts/fa-solid-900.woff2';

// Ícones cujo nome é montado em runtime (fa-${var}) — rastreados manualmente
// porque o scanner estático não os enxerga. Mantenha sincronizado se surgirem novos.
const SAFELIST = [
  'fa-arrow-up', 'fa-arrow-down', 'fa-minus', 'fa-check', 'fa-exclamation-triangle',
];

const TOKEN_RE = /\bfa-[a-z0-9][a-z0-9-]*/g;

// ── 1. Coleta tokens fa-* de .html/.js (onde classes de ícone vivem) ───────────
function scanInto(tokens, dir, { recursive }) {
  for (const entry of readdirSync(dir, { recursive, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== '.html' && ext !== '.js') continue;
    const full = join(entry.parentPath ?? dir, entry.name);
    const text = readFileSync(full, 'utf8');
    for (const m of text.matchAll(TOKEN_RE)) tokens.add(m[0]);
  }
}

const used = new Set(SAFELIST);
scanInto(used, join(ROOT, 'src'), { recursive: true });     // src/ inteiro
scanInto(used, join(ROOT, 'public'), { recursive: true });  // public/ (graficos.js et al. vivem aqui)
scanInto(used, ROOT, { recursive: false });                 // *.html da raiz

// ── 2. Lê o CSS oficial e poda glifos não usados ──────────────────────────────
let css = readFileSync(FA_CSS, 'utf8');

// Remove TODOS os @font-face (vamos injetar só o solid-900)
css = css.replace(/@font-face\{[^}]*\}/g, '');

// Poda regras de glifo (incl. agrupadas por alias: `.fa-a,.fa-b{--fa:"\fXXX"}`).
// Mantém a regra inteira se QUALQUER um de seus seletores estiver em uso.
// Coleta também os codepoints das regras mantidas → usados para subsetar o woff2.
const glyphCodepoints = new Set();
let kept = 0, dropped = 0;
css = css.replace(/((?:\.fa-[a-z0-9-]+,)*\.fa-[a-z0-9-]+)\{--fa:"([^"]*)"\}/g, (full, selectors, content) => {
  const names = selectors.split(',').map(s => s.slice(1)); // remove o ponto
  if (names.some(n => used.has(n))) {
    kept++;
    // Conteúdo é tipo "\f015" — extrai cada escape unicode da regra mantida.
    for (const m of content.matchAll(/\\([0-9a-fA-F]+)/g)) {
      glyphCodepoints.add(parseInt(m[1], 16));
    }
    return full;
  }
  dropped++; return '';
});

// ── 3. @font-face único (solid-900); font-display:block evita "tofu" no 1º paint
const fontFace =
  '@font-face{font-family:"Font Awesome 7 Free";font-style:normal;font-weight:900;' +
  `font-display:block;src:url('${FONT_URL}') format("woff2")}`;

const header =
  '/* GERADO por scripts/build-fa-subset.mjs — NÃO editar à mão. */\n' +
  `/* ${kept} ícones usados | ${dropped} podados | peso: solid */\n`;

mkdirSync(dirname(OUT_CSS), { recursive: true });
writeFileSync(OUT_CSS, header + fontFace + css, 'utf8');

// ── 4. Subseta a FONTE (woff2) para conter só os glifos usados ─────────────────
// O passo 2 já podou o CSS, mas a fonte original (fa-solid-900.woff2) carrega
// ~2000 glifos (~114 KB). Aqui geramos um woff2 contendo APENAS os codepoints
// das regras mantidas — mesmo conjunto que o CSS já referencia, então NÃO há
// risco de cobertura adicional: qualquer ícone ausente já estaria podado do CSS.
//
// font-display:block: a fonte bloqueia o render dos ícones até baixar, logo
// reduzir seu peso melhora diretamente o tempo até o 1º ícone em redes lentas.
//
// FALLBACK SEGURO: qualquer falha no subset → copia a fonte completa (idêntico
// ao comportamento anterior). O build NUNCA quebra por causa desta otimização.
mkdirSync(OUT_FONTS, { recursive: true });
const OUT_WOFF2 = join(OUT_FONTS, 'fa-solid-900.woff2');
const fullBuf   = readFileSync(FA_WOFF2);

try {
  if (glyphCodepoints.size === 0) {
    throw new Error('nenhum codepoint coletado das regras mantidas');
  }
  // Inclui sempre o espaço (U+0020) — algumas engines exigem para métricas.
  glyphCodepoints.add(0x20);
  const subsetText = [...glyphCodepoints].map(cp => String.fromCodePoint(cp)).join('');
  const subsetBuf  = await subsetFont(fullBuf, subsetText, { targetFormat: 'woff2' });

  // Sanidade: subset precisa ser menor que a fonte original e não-vazio.
  if (!subsetBuf || subsetBuf.length === 0 || subsetBuf.length >= fullBuf.length) {
    throw new Error(`subset suspeito (${subsetBuf?.length ?? 0} vs ${fullBuf.length} bytes)`);
  }
  writeFileSync(OUT_WOFF2, subsetBuf);
  const pct = ((1 - subsetBuf.length / fullBuf.length) * 100).toFixed(1);
  console.log(
    `[fa-subset] fonte: ${glyphCodepoints.size} glifos | ` +
    `${(fullBuf.length / 1024).toFixed(1)} KB → ${(subsetBuf.length / 1024).toFixed(1)} KB (−${pct}%)`
  );
} catch (err) {
  copyFileSync(FA_WOFF2, OUT_WOFF2);
  console.warn(`[fa-subset] ⚠️ subset do woff2 falhou (${err.message}) — usando fonte completa (fallback seguro)`);
}

console.log(`[fa-subset] ${kept} ícones mantidos, ${dropped} podados → ${OUT_CSS}`);
