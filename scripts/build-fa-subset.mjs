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
scanInto(used, join(ROOT, 'src'), { recursive: true });  // src/ inteiro
scanInto(used, ROOT, { recursive: false });              // *.html da raiz

// ── 2. Lê o CSS oficial e poda glifos não usados ──────────────────────────────
let css = readFileSync(FA_CSS, 'utf8');

// Remove TODOS os @font-face (vamos injetar só o solid-900)
css = css.replace(/@font-face\{[^}]*\}/g, '');

// Poda regras de glifo (incl. agrupadas por alias: `.fa-a,.fa-b{--fa:"\fXXX"}`).
// Mantém a regra inteira se QUALQUER um de seus seletores estiver em uso.
let kept = 0, dropped = 0;
css = css.replace(/((?:\.fa-[a-z0-9-]+,)*\.fa-[a-z0-9-]+)\{--fa:"[^"]*"\}/g, (full, selectors) => {
  const names = selectors.split(',').map(s => s.slice(1)); // remove o ponto
  if (names.some(n => used.has(n))) { kept++; return full; }
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

// ── 4. Copia a fonte para public/ (servida em /assets/fonts/) ──────────────────
mkdirSync(OUT_FONTS, { recursive: true });
copyFileSync(FA_WOFF2, join(OUT_FONTS, 'fa-solid-900.woff2'));

console.log(`[fa-subset] ${kept} ícones mantidos, ${dropped} podados → ${OUT_CSS}`);
