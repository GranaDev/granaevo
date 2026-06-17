// scripts/build-fonts-subset.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gera um CSS consolidado de fontes self-hosted contendo APENAS:
//   • os subsets necessários (latin + latin-ext) — pt-BR não usa grego/cirílico/vietnamita
//   • formato woff2 (todo browser-alvo suporta; o .woff legado é peso morto)
//   • somente os pesos realmente usados por família
//
// Fonte dos dados: pacotes @fontsource (mesmos arquivos do Google Fonts, self-hosted).
// Roda no `prebuild` junto do subset do Font Awesome — nunca fica desatualizado.
//
// Antes: Inter com 7 pesos × 7 subsets × (woff2+woff) ≈ 1.56 MB no dist, e ainda
//        DM Sans/Syne/Outfit vindo do Google CDN (origem externa render-blocking).
// Depois: tudo self-hosted, woff2-only, latin(+ext) → fração do peso, zero CDN externo.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const FS_DIR    = join(ROOT, 'node_modules', '@fontsource');
const OUT_CSS   = join(ROOT, 'src', 'styles', 'vendor', 'fonts-subset.css');
const OUT_CSS_DASHBOARD = join(ROOT, 'src', 'styles', 'vendor', 'fonts-dashboard.css');
const OUT_FONTS = join(ROOT, 'public', 'assets', 'fonts');
const FONT_URL_BASE = '/assets/fonts';

// Subsets mantidos. latin cobre todo o português: acentos (U+00C0–00FF), aspas
// curvas/travessões (U+2000–206F) e o símbolo R$ (ASCII). latin-ext (U+0100+)
// cobre só polonês/turco/tcheco e moedas exóticas — inútil em PT-BR e, por causa
// do unicode-range, nem chega a ser baixado. Removido para enxugar dist/precache.
const KEEP_SUBSETS = new Set(['latin']);

// Famílias + pesos realmente usados (ver grep de font-weight / URLs do Google que substituímos).
const FAMILIES = [
  { pkg: 'inter',   weights: [400, 500, 600, 700, 800, 900] },       // body landing + fallback dashboard (300 não é usado em lugar nenhum)
  { pkg: 'dm-sans', weights: [400, 500, 600, 700] },                 // body dashboard
  { pkg: 'syne',    weights: [700, 800] },                           // títulos dashboard
  { pkg: 'outfit',  weights: [400, 500, 600, 700, 800, 900] },       // convidados
];

const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/g;
const WOFF2_RE     = /url\(([^)]*?\.woff2)\)/;
const FAMILY_RE    = /font-family:\s*([^;]+);/;
const WEIGHT_RE    = /font-weight:\s*([^;]+);/;
const STYLE_RE     = /font-style:\s*([^;]+);/;
const RANGE_RE     = /unicode-range:\s*([^;]+);/;

mkdirSync(OUT_FONTS, { recursive: true });
mkdirSync(dirname(OUT_CSS), { recursive: true });

let copied = 0;
const seenFiles = new Set();

// Gera os @font-face de uma lista de famílias. Copia cada woff2 uma única vez
// (dedup global via seenFiles), então o mesmo arquivo servir a vários bundles
// não duplica bytes em public/.
function buildFamilies(families) {
  let out = '', kept = 0;
  for (const { pkg, weights } of families) {
    for (const weight of weights) {
      const cssPath = join(FS_DIR, pkg, `${weight}.css`);
      if (!existsSync(cssPath)) {
        console.warn(`[fonts] aviso: ${pkg}/${weight}.css inexistente — pulado`);
        continue;
      }
      const css = readFileSync(cssPath, 'utf8');
      for (const m of css.matchAll(FONT_FACE_RE)) {
        const body = m[1];
        const woff2 = body.match(WOFF2_RE);
        if (!woff2) continue;

        const file = basename(woff2[1]);                 // ex.: inter-latin-ext-400-normal.woff2
        // subset = trecho entre "{pkg}-" e "-{weight}-normal"
        const subset = file.replace(`${pkg}-`, '').replace(`-${weight}-normal.woff2`, '');
        if (!KEEP_SUBSETS.has(subset)) continue;

        const family = body.match(FAMILY_RE)?.[1].trim() ?? `'${pkg}'`;
        const fweight = body.match(WEIGHT_RE)?.[1].trim() ?? String(weight);
        const fstyle = body.match(STYLE_RE)?.[1].trim() ?? 'normal';
        const range = body.match(RANGE_RE)?.[1].trim();

        // Copia o woff2 (uma vez) para public/assets/fonts/
        if (!seenFiles.has(file)) {
          copyFileSync(join(FS_DIR, pkg, 'files', file), join(OUT_FONTS, file));
          seenFiles.add(file);
          copied++;
        }

        out +=
          '@font-face{' +
          `font-family:${family};` +
          `font-style:${fstyle};` +
          'font-display:swap;' +
          `font-weight:${fweight};` +
          `src:url('${FONT_URL_BASE}/${file}') format('woff2')` +
          (range ? `;unicode-range:${range}` : '') +
          '}\n';
        kept++;
      }
    }
  }
  return { out, kept };
}

function header(kept) {
  return '/* GERADO por scripts/build-fonts-subset.mjs — NÃO editar à mão. */\n' +
    `/* ${kept} @font-face | subsets: ${[...KEEP_SUBSETS].join(', ')} */\n`;
}

// 1. Bundle COMPLETO (todas as famílias) — usado por landing/login/planos/etc,
//    que usam Inter no corpo e Outfit (convidados).
const full = buildFamilies(FAMILIES);
writeFileSync(OUT_CSS, header(full.kept) + full.out, 'utf8');

// 2. Bundle do DASHBOARD — só DM Sans (corpo) + Syne (títulos). O dashboard não
//    usa Outfit, e cita 'Inter' apenas como fallback depois de DM Sans (que
//    sempre carrega), então declarar Inter ali é peso morto no parse de CSS.
const DASHBOARD_FAMILIES = FAMILIES.filter(f => f.pkg === 'dm-sans' || f.pkg === 'syne');
const dash = buildFamilies(DASHBOARD_FAMILIES);
writeFileSync(OUT_CSS_DASHBOARD, header(dash.kept) + dash.out, 'utf8');

console.log(`[fonts] full: ${full.kept} @font-face → ${OUT_CSS}`);
console.log(`[fonts] dashboard: ${dash.kept} @font-face → ${OUT_CSS_DASHBOARD}`);
console.log(`[fonts] ${copied} woff2 copiados (dedup) → ${OUT_FONTS}`);
