#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-allowlist.mjs — campos gravados que o SAVE descarta em silêncio
//
// POR QUE ESTE SCRIPT EXISTE: o save reconstrói cada objeto a partir de um
// allowlist (`_ALLOWED_KEYS` em dashboard.js). Um campo novo que não entre lá é
// simplesmente DESCARTADO na próxima gravação — sem erro, sem aviso. O recurso
// funciona na tela e some no reload, e a causa é invisível em code review.
//
// Este padrão causou QUATRO bugs neste projeto em um único dia (2026-07-18/19):
// campos da reserva compartilhada, `alvo` dos desafios de teto, a senha do
// step-up no proxy, e o alvo persistido do desafio. Todos idênticos.
//
// Roda junto de check-refs no CI. Não substitui revisão: aponta suspeita, e
// campo intencionalmente efêmero pode ser listado em IGNORAR abaixo.
// ----------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';

const DASH = 'src/scripts/pages/dashboard.js';
const dash = fs.readFileSync(DASH, 'utf8');

// Campos que NÃO devem ser persistidos de propósito (só existem em memória).
const IGNORAR = new Set([
  // (vazio por ora — adicionar aqui com justificativa, nunca em silêncio)
]);

function allowlistDe(nome) {
  const re = new RegExp(nome + String.raw`:\s*Object\.freeze\(\[([\s\S]*?)\]\)`);
  const m = re.exec(dash);
  return m ? new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) : null;
}

const alvos = {
  transacao:  { allow: allowlistDe('transacao'),  arr: 'transacoes' },
  meta:       { allow: allowlistDe('meta'),       arr: 'metas' },
  contaFixa:  { allow: allowlistDe('contaFixa'),  arr: 'contasFixas' },
  cartao:     { allow: allowlistDe('cartao'),     arr: 'cartoesCredito' },
  assinatura: { allow: allowlistDe('assinatura'), arr: 'assinaturas' },
};

let erro = false;
for (const [k, v] of Object.entries(alvos)) {
  if (!v.allow) { console.error(`✗ allowlist de "${k}" não encontrada em ${DASH}`); erro = true; }
}

const arquivos = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.js')) arquivos.push(p);
  }
})('src/scripts');

const suspeitos = new Map();
for (const arq of arquivos) {
  const src = fs.readFileSync(arq, 'utf8');
  for (const [tipo, { allow, arr }] of Object.entries(alvos)) {
    if (!allow) continue;
    const re = new RegExp(String.raw`\b` + arr + String.raw`\.push\(\s*\{([\s\S]{0,700}?)\}\s*\)`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const campos = [...m[1].matchAll(/(?:^|[\s,{])([a-zA-Z_][\w]*)\s*:/g)].map((x) => x[1]);
      for (const campo of campos) {
        if (allow.has(campo) || IGNORAR.has(campo)) continue;
        const chave = `${tipo}.${campo}`;
        if (!suspeitos.has(chave)) suspeitos.set(chave, new Set());
        suspeitos.get(chave).add(arq.split(path.sep).join('/'));
      }
    }
  }
}

if (suspeitos.size) {
  console.error('✗ check-allowlist: campos gravados que o save DESCARTA:\n');
  for (const [k, arqs] of suspeitos) console.error(`   ${k}\n      ← ${[...arqs].join('\n      ← ')}`);
  console.error('\n  Ou adicione o campo ao _ALLOWED_KEYS correspondente em ' + DASH + ',');
  console.error('  ou registre-o em IGNORAR neste script (com justificativa).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SEGUNDA PASSAGEM (Passo 37.0a): todo registro criado nasce com `id`.
//
// É o mesmo tipo de falha que motivou o script acima — silenciosa. Sem `id` o
// save só sabe dizer "aqui está o estado inteiro", e é assim que uma aba apaga
// o lançamento que a outra acabou de fazer. Nada quebra, nada avisa: o registro
// simplesmente some no reload.
//
// A rede em data-manager (`carimbarNovos`) sorteia um id para quem chegar sem,
// mas ela NÃO substitui o carimbo na criação: o dashboard reconstrói cada objeto
// pelo allowlist antes de salvar, então a rede carimba a CÓPIA — o array vivo da
// tela continua sem id e sortearia outro no save seguinte. O mesmo registro
// pareceria "apagado e recriado" a cada gravação.
// ---------------------------------------------------------------------------
const semId = new Map();
for (const arq of arquivos) {
  const src = fs.readFileSync(arq, 'utf8');
  for (const arr of Object.values(alvos).map((v) => v.arr)) {
    const re = new RegExp(String.raw`\b` + arr + String.raw`\.push\(\s*\{([\s\S]{0,700}?)\}\s*\)`, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (/(?:^|[\s,{])id\s*:/.test(m[1])) continue;
      const linha = src.slice(0, m.index).split('\n').length;
      const chave = `${arq.split(path.sep).join('/')}:${linha}`;
      semId.set(chave, arr);
    }
  }
}

if (semId.size) {
  console.error('✗ check-allowlist: registro criado SEM `id` (Passo 37 — identidade):\n');
  for (const [onde, arr] of semId) console.error(`   ${arr}  ←  ${onde}`);
  console.error('\n  Use novoId() de src/scripts/modules/registro-id.js na criação.');
  process.exit(1);
}

// E quem CHAMA novoId() tem de IMPORTAR novoId. Parece redundante e não é: o
// rollup trata identificador não declarado como global do navegador e o build
// passa VERDE — foi assim que os botões de Reservas quebraram em produção, com
// ReferenceError só no clique do usuário. O import some fácil (um `git checkout`
// desatento apagou este mesmo, hoje).
const semImport = [];
for (const arq of arquivos) {
  const src = fs.readFileSync(arq, 'utf8');
  if (!/\bnovoId\s*\(/.test(src)) continue;
  if (arq.split(path.sep).join('/').endsWith('src/scripts/modules/registro-id.js')) continue;
  if (/import\s*\{[^}]*\bnovoId\b[^}]*\}\s*from\s*['"][^'"]*registro-id\.js/.test(src)) continue;
  // Declaração local com o mesmo nome (ex.: `const novoId = crypto.randomUUID()`)
  // não é a função compartilhada — é outra coisa, e não precisa do import.
  if (/(?:const|let|var|function)\s+novoId\b/.test(src)) continue;
  semImport.push(arq.split(path.sep).join('/'));
}

if (semImport.length) {
  console.error('✗ check-allowlist: chama novoId() sem importar (quebra só no clique):\n');
  for (const a of semImport) console.error(`   ${a}`);
  console.error("\n  Falta: import { novoId } from '<caminho>/registro-id.js?v=1';");
  process.exit(1);
}

if (erro) process.exit(1);
console.log('✓ check-allowlist: nenhum campo fora do allowlist, nenhum registro sem id');
