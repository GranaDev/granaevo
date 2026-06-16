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
const OUT_FONTS = join(ROOT, 'public', 'assets', 'fonts');
const FONT_URL_BASE = '/assets/fonts';

// Subsets mantidos. latin cobre todo o português (acentos U+00C0–00FF);
// latin-ext entra como rede de segurança barata (traços tipográficos, moedas).
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

// Famílias + pesos realmente usados (ver grep de font-weight / URLs do Google que substituímos).
const FAMILIES = [
  { pkg: 'inter',   weights: [300, 400, 500, 600, 700, 800, 900] }, // body landing + fallback dashboard
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

let out = '';
let kept = 0, copied = 0;
const seenFiles = new Set();

for (const { pkg, weights } of FAMILIES) {
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

const header =
  '/* GERADO por scripts/build-fonts-subset.mjs — NÃO editar à mão. */\n' +
  `/* ${kept} @font-face | ${copied} woff2 | subsets: ${[...KEEP_SUBSETS].join(', ')} */\n`;

writeFileSync(OUT_CSS, header + out, 'utf8');
console.log(`[fonts] ${kept} @font-face gerados, ${copied} woff2 copiados → ${OUT_CSS}`);
