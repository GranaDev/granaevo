// scripts/optimize-images.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Otimizador de imagens reutilizável (usa sharp).
// Converte PNG/JPG/JPEG/GIF para WebP e reporta a economia. NÃO apaga os
// originais — gera o .webp ao lado; você revisa, troca as referências e remove.
//
// Uso:
//   node scripts/optimize-images.mjs [pasta] [--quality=80] [--replace]
//   npm run images:optimize -- public/assets/icons --quality=80
//
//   pasta       diretório a varrer recursivamente (default: public/assets)
//   --quality   qualidade WebP 1-100 (default: 80)
//   --replace   remove o original após gerar o .webp (use com cuidado)
//
// Histórico: os 8 ícones de navegação (GIF estático → WebP) foram convertidos
// com esta lógica, economizando ~16,5 KB. Mantido como ferramenta versionada.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const args     = process.argv.slice(2);
const dirArg   = args.find(a => !a.startsWith('--')) ?? 'public/assets';
const quality  = Number((args.find(a => a.startsWith('--quality=')) ?? '--quality=80').split('=')[1]) || 80;
const replace  = args.includes('--replace');
const TARGET   = resolve(ROOT, dirArg);
const EXTS     = new Set(['.png', '.jpg', '.jpeg', '.gif']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXTS.has(extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

const files = walk(TARGET);
if (files.length === 0) {
  console.log(`Nenhuma imagem (${[...EXTS].join(', ')}) encontrada em ${dirArg}`);
  process.exit(0);
}

console.log(`\n🖼️  Otimizando ${files.length} imagem(ns) em ${dirArg} (WebP q=${quality})\n`);

let totalBefore = 0;
let totalAfter  = 0;

for (const file of files) {
  const before = statSync(file).size;
  const out    = file.replace(/\.(png|jpe?g|gif)$/i, '.webp');
  try {
    const info = await sharp(file, { animated: true }).webp({ quality, effort: 6 }).toFile(out);
    totalBefore += before;
    totalAfter  += info.size;
    const saved = before - info.size;
    const pct   = Math.round((Math.abs(saved) / before) * 100);
    // WebP nem sempre vence: PNGs pequenos já otimizados podem ficar maiores.
    const smaller = saved >= 0;
    console.log(`  ${smaller ? '✅' : '⚠️ '} ${file.replace(ROOT, '.')}  ${before} → ${info.size} B  (${smaller ? '-' : '+'}${pct}%)`);
    // Só remove o original se pedido E se o WebP realmente ficou menor.
    if (replace && smaller) rmSync(file);
  } catch (e) {
    console.error(`  ❌ ${file.replace(ROOT, '.')}  falhou: ${e.message}`);
  }
}

const savedKB = ((totalBefore - totalAfter) / 1024).toFixed(1);
console.log(`\n📦 Total: ${(totalBefore / 1024).toFixed(1)} KB → ${(totalAfter / 1024).toFixed(1)} KB  (economia ${savedKB} KB)`);
if (!replace) console.log('ℹ️  Originais preservados. Rode com --replace para removê-los após trocar as referências.\n');
