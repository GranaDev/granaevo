// Gera public/assets/icons/og-image.png (1200x630) — banner de compartilhamento
// (Open Graph / Twitter Card). Rodar: node scripts/build-og-image.mjs
// Composição: fundo escuro da marca + glow esmeralda + logo + título + gráfico.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const logo = readFileSync(join(ROOT, 'public/assets/icons/pwa-512.png'));
const logoB64 = logo.toString('base64');

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0b14"/>
      <stop offset="1" stop-color="#12172a"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.15" r="0.9">
      <stop offset="0" stop-color="#10b981" stop-opacity="0.28"/>
      <stop offset="0.55" stop-color="#10b981" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#10b981"/>
      <stop offset="1" stop-color="#059669"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- gráfico decorativo (barras crescentes, canto direito) -->
  <g opacity="0.55">
    <rect x="820" y="430" width="52" height="90"  rx="10" fill="#134e3a"/>
    <rect x="892" y="390" width="52" height="130" rx="10" fill="#166b4c"/>
    <rect x="964" y="340" width="52" height="180" rx="10" fill="#0e9f6e"/>
    <rect x="1036" y="280" width="52" height="240" rx="10" fill="#10b981"/>
    <path d="M 830 400 L 905 360 L 978 305 L 1055 240" stroke="#6ee7b7" stroke-width="7" fill="none" stroke-linecap="round"/>
    <circle cx="1055" cy="240" r="12" fill="#6ee7b7"/>
  </g>

  <!-- logo -->
  <image x="88" y="96" width="112" height="112" xlink:href="data:image/png;base64,${logoB64}"/>

  <text x="220" y="176" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="800" fill="#ffffff">GranaEvo</text>

  <text x="92" y="308" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="800" fill="#ffffff">Domine suas finanças</text>
  <text x="92" y="380" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="800" fill="#34d399">com inteligência.</text>

  <text x="92" y="452" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#9ca3af">Gastos, cartões, metas e reservas — sem conectar sua conta bancária.</text>

  <rect x="92" y="496" width="360" height="64" rx="32" fill="url(#bar)"/>
  <text x="272" y="538" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700" fill="#ffffff" text-anchor="middle">granaevo.com</text>
</svg>`;

await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(join(ROOT, 'public/assets/icons/og-image.png'));

const meta = await sharp(join(ROOT, 'public/assets/icons/og-image.png')).metadata();
console.log('gerado:', meta.width, 'x', meta.height);
