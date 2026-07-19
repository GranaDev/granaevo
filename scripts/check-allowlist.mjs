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

if (erro) process.exit(1);
console.log('✓ check-allowlist: nenhum campo gravado fora do allowlist');
