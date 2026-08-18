#!/usr/bin/env node
// scripts/check-client-columns.mjs — a coluna que o código escreve existe? e é permitida?
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTE SCRIPT EXISTE (2026-08-17)
//
// `check-policy-grant.mjs` termina dizendo, no próprio cabeçalho, qual metade do
// defeito ele NÃO pega:
//
//   "Ele responde 'o role consegue exercer este comando nesta tabela?'. Não
//    responde 'consegue exercer NA COLUNA que o cliente precisa?'.
//    Pegar o outro exige cruzar com o CLIENTE: para cada `.update({a, b})`,
//    conferir grant de coluna para `a` e para `b`. É a evolução natural daqui
//    — não feita ainda."
//
// Isto é essa evolução. E a auditoria de 2026-08-17 achou o caso mais cru da
// família, que nem grant envolvia — a coluna simplesmente NÃO EXISTIA:
//
//   db.from('profiles').update({ is_active: false, updated_at: ... })
//                                                  ^^^^^^^^^^
//   `profiles` é (id, user_id, name, photo_url, created_at, is_active).
//
// O PostgREST devolvia 42703 e o UPDATE não acontecia. Efeito: o enforcement do
// downgrade de plano NUNCA desativou perfil nenhum — o usuário descia de família
// para individual e ficava com os 4 perfis. Quatro pontos tinham o mesmo defeito,
// dois deles no caminho de desativação e dois queimando o backup do usuário.
//
// Havia `console.error` nos dois blocos. O erro era logado e ignorado. Nada no
// build, nos testes ou no lint pegava, porque o defeito não está no código nem no
// banco isoladamente — está na COMBINAÇÃO, exatamente como o bug de 2026-08-09.
//
// AS DUAS PERGUNTAS QUE ESTE SCRIPT FAZ, para cada `.update({...})`/`.insert({...})`:
//
//   1. EXISTÊNCIA  — a coluna existe na tabela?           (todo o codebase)
//   2. PRIVILÉGIO  — `authenticated` pode escrever nela?  (só src/scripts, que
//                     roda no navegador; api/ e supabase/functions/ usam
//                     service_role e não dependem de grant)
//
// O QUE ELE NÃO PROVA — dito aqui para não virar verde enganoso:
//   · `.update(variavel)` não é verificável estaticamente. Não é ignorado: entra
//     no relatório como NÃO-VERIFICÁVEL, com arquivo e linha. Silenciar isso
//     seria reproduzir o defeito que o script existe para pegar.
//   · Não avalia RLS. Coluna existir e ter grant não implica a linha passar na
//     policy — para isso é o check-policy-grant.mjs.
//
// USO
//   node scripts/check-client-columns.mjs           (relata; sai 0)
//   node scripts/check-client-columns.mjs --strict  (sai 1 se achar problema)
//
// Precisa de SUPABASE_ACCESS_TOKEN. Fora do CI pelo mesmo motivo do irmão: um
// passo que falha por falta de credencial ensina a ignorar o CI.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REF   = process.env.SUPABASE_PROJECT_REF ?? 'fvrhqqeofqedmhadzzqw';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

// `fileURLToPath` e NÃO `new URL(...).pathname`: o caminho deste projeto contém
// acento e espaço ("Aleatórios Gerais"), que a URL percent-encoda
// (Aleat%C3%B3rios%20Gerais). O pathname cru não existe no disco, o readdirSync
// falha, e — na primeira versão deste script — o catch silencioso transformava
// isso em "0 escritas analisadas ✓". Verde perfeito, zero arquivos lidos.
// Foi o próprio defeito que este script existe para pegar, cometido aqui dentro.
const RAIZ = fileURLToPath(new URL('..', import.meta.url));

if (!TOKEN) {
    console.error('Falta SUPABASE_ACCESS_TOKEN no ambiente.');
    process.exit(2);
}

async function sql(query) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
}

// ── 1. Verdade do banco ──────────────────────────────────────────────────────

const colunas = await sql(`
  SELECT table_name, column_name,
         has_column_privilege('authenticated', ('public.'||table_name)::regclass, column_name, 'UPDATE') AS pode_update,
         has_column_privilege('authenticated', ('public.'||table_name)::regclass, column_name, 'INSERT') AS pode_insert
    FROM information_schema.columns
   WHERE table_schema = 'public'`);

/** tabela -> Map(coluna -> {pode_update, pode_insert}) */
const schema = new Map();
for (const c of colunas) {
    if (!schema.has(c.table_name)) schema.set(c.table_name, new Map());
    schema.get(c.table_name).set(c.column_name, {
        update: c.pode_update === true || c.pode_update === 't',
        insert: c.pode_insert === true || c.pode_insert === 't',
    });
}

// ── 2. Varredura do código ───────────────────────────────────────────────────

const ALVOS = [
    { dir: 'src/scripts',         cliente: true  },  // roda no navegador → grant importa
    { dir: 'api',                 cliente: false },  // service_role
    { dir: 'supabase/functions',  cliente: false },  // service_role
];

function arquivos(dir) {
    const out = [];
    const caminho = join(RAIZ, dir);
    // A raiz TEM de existir. Um diretório-alvo ilegível é falha do script, não
    // "nada a relatar" — sem isto, um erro de caminho vira aprovação silenciosa.
    if (!statSync(caminho, { throwIfNoEntry: false })?.isDirectory()) {
        console.error(`[check-client-columns] diretório-alvo inacessível: ${caminho}`);
        process.exit(2);
    }
    (function anda(d) {
        const entradas = readdirSync(d);
        for (const e of entradas) {
            const p = join(d, e);
            if (statSync(p).isDirectory()) { anda(p); continue; }
            if (/\.(js|ts|mjs)$/.test(e)) out.push(p);
        }
    })(caminho);
    return out;
}

/**
 * Apaga comentários preservando OFFSET e linhas (troca por espaço, mantém \n).
 *
 * Sem isto o scanner casa código citado em comentário. Aconteceu na primeira
 * versão: um comentário explicando o bug — `aqui havia um .update({is_active})` —
 * foi lido como escrita real e virou achado falso. Comentário é prosa; se ele
 * puder reprovar o build, todo mundo aprende a não escrever comentário.
 */
function semComentarios(src) {
    const out = Array.from(src);
    let estado = 'codigo';   // codigo | linha | bloco | ' | " | `
    for (let i = 0; i < src.length; i++) {
        const c = src[i], prox = src[i + 1], ant = src[i - 1];
        switch (estado) {
            case 'codigo':
                if (c === '/' && prox === '/') { estado = 'linha';  out[i] = out[i + 1] = ' '; i++; }
                else if (c === '/' && prox === '*') { estado = 'bloco'; out[i] = out[i + 1] = ' '; i++; }
                else if (c === "'" || c === '"' || c === '`') estado = c;
                break;
            case 'linha':
                if (c === '\n') estado = 'codigo'; else out[i] = ' ';
                break;
            case 'bloco':
                if (c === '*' && prox === '/') { estado = 'codigo'; out[i] = out[i + 1] = ' '; i++; }
                else if (c !== '\n') out[i] = ' ';
                break;
            default:  // dentro de string
                if (c === estado && ant !== '\\') estado = 'codigo';
                break;
        }
    }
    return out.join('');
}

/**
 * Extrai o literal de objeto que começa em `src[i]` (que deve ser '{'),
 * respeitando aninhamento, strings e template literals. Devolve null se não
 * fechar — arquivo truncado ou nosso scanner errado; nos dois casos, não fingir
 * que leu.
 */
function objetoLiteral(src, i) {
    if (src[i] !== '{') return null;
    let nivel = 0, aspas = null;
    for (let j = i; j < src.length; j++) {
        const c = src[j], ant = src[j - 1];
        if (aspas) {
            if (c === aspas && ant !== '\\') aspas = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { aspas = c; continue; }
        if (c === '{') nivel++;
        else if (c === '}') { nivel--; if (nivel === 0) return src.slice(i, j + 1); }
    }
    return null;
}

/** Chaves de PRIMEIRO nível do literal. Ignora o que estiver aninhado. */
function chavesTopo(obj) {
    const corpo = obj.slice(1, -1);
    const chaves = [];
    let nivel = 0, aspas = null, termo = '';
    const empurra = () => {
        const m = termo.match(/^\s*(?:\.\.\.)?\s*['"`]?([A-Za-z_$][\w$]*)['"`]?\s*:/);
        if (m) chaves.push(m[1]);
        else if (/^\s*\.\.\./.test(termo)) chaves.push('...SPREAD');
        else {
            const s = termo.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);   // shorthand { a, b }
            if (s) chaves.push(s[1]);
        }
        termo = '';
    };
    for (let j = 0; j < corpo.length; j++) {
        const c = corpo[j], ant = corpo[j - 1];
        if (aspas) { termo += c; if (c === aspas && ant !== '\\') aspas = null; continue; }
        if (c === '"' || c === "'" || c === '`') { aspas = c; termo += c; continue; }
        if (c === '{' || c === '[' || c === '(') nivel++;
        if (c === '}' || c === ']' || c === ')') nivel--;
        if (c === ',' && nivel === 0) { empurra(); continue; }
        termo += c;
    }
    empurra();
    return chaves;
}

const problemas = [];      // coluna inexistente OU sem grant
const naoVerificaveis = []; // .update(variavel), spread, etc.
let escritasLidas = 0;

for (const { dir, cliente } of ALVOS) {
    for (const arq of arquivos(dir)) {
        const src = semComentarios(readFileSync(arq, 'utf8'));
        const rel = relative(RAIZ, arq).replace(/\\/g, '/');

        // `.from('tabela')` … `.update(` / `.insert(` / `.upsert(`
        const re = /\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const tabela = m[1];
            if (!schema.has(tabela)) continue;              // tabela de outro schema/serviço

            // Procura a operação de escrita mais próxima, dentro de uma janela
            // curta (a cadeia costuma ser contígua). Janela por CONTEÚDO e não
            // por número fixo de bytes: para no próximo `.from(` para não roubar
            // a escrita da consulta seguinte.
            const resto = src.slice(m.index + m[0].length);
            const proximoFrom = resto.search(/\.from\(\s*['"`]/);
            const janela = proximoFrom === -1 ? resto : resto.slice(0, proximoFrom);

            const op = janela.match(/\.(update|insert|upsert)\s*\(/);
            if (!op) continue;

            escritasLidas++;
            const linha = src.slice(0, m.index).split('\n').length;
            const inicio = janela.indexOf(op[0]) + op[0].length;
            let k = inicio;
            while (k < janela.length && /\s/.test(janela[k])) k++;

            // `.insert([{...}])` — entra no array antes do objeto
            if (janela[k] === '[') { k++; while (k < janela.length && /\s/.test(janela[k])) k++; }

            if (janela[k] !== '{') {
                naoVerificaveis.push({ rel, linha, tabela, op: op[1], motivo: 'argumento não é literal' });
                continue;
            }
            const obj = objetoLiteral(janela, k);
            if (!obj) {
                naoVerificaveis.push({ rel, linha, tabela, op: op[1], motivo: 'literal não fechou' });
                continue;
            }

            const cols = schema.get(tabela);
            for (const chave of chavesTopo(obj)) {
                if (chave === '...SPREAD') {
                    naoVerificaveis.push({ rel, linha, tabela, op: op[1], motivo: 'spread no objeto' });
                    continue;
                }
                if (!cols.has(chave)) {
                    problemas.push({ rel, linha, tabela, op: op[1], coluna: chave, tipo: 'INEXISTENTE' });
                    continue;
                }
                if (cliente) {
                    const priv = cols.get(chave);
                    const precisa = op[1] === 'insert' ? 'insert' : (op[1] === 'upsert' ? 'insert' : 'update');
                    if (!priv[precisa]) {
                        problemas.push({ rel, linha, tabela, op: op[1], coluna: chave, tipo: 'SEM GRANT' });
                    }
                }
            }
        }
    }
}

// ── 2B. INVARIANTES DE GRANT — o que nunca pode voltar a existir ─────────────
//
// A varredura acima pergunta "o que o código escreve?". Esta seção pergunta o
// contrário: "o que o cliente CONSEGUE escrever, mesmo que nenhum código nosso
// escreva hoje?". É a pergunta que faltou em SEC-001 — `is_active` não aparecia
// em `.update()` nenhum do cliente, e mesmo assim estava ao alcance de um PATCH.
//
// Cada linha aqui é uma vulnerabilidade fechada. Se voltar a ficar verdadeira,
// a vulnerabilidade voltou — por um restore que não trouxe os REVOKE (ver
// `restore_perde_os_revokes`), por um `db push` de outra máquina, pelo dashboard.
const INVARIANTES = [
    { tabela: 'profiles',           coluna: 'is_active', priv: 'UPDATE',
      porque: 'SEC-001: PATCH direto religava perfil e furava o limite do plano' },
    { tabela: 'profiles',           coluna: 'is_active', priv: 'INSERT',
      porque: 'SEC-001: is_active deve tomar sempre o DEFAULT, nunca vir do cliente' },
    { tabela: 'push_subscriptions', coluna: 'endpoint',  priv: 'UPDATE',
      porque: 'SEC-002: endpoint escolhido pelo cliente vira destino de requisição do backend' },
    { tabela: 'push_subscriptions', coluna: 'endpoint',  priv: 'INSERT',
      porque: 'SEC-002: idem, pelo caminho de inserção' },
    { tabela: 'user_data',          coluna: 'data_json', priv: 'UPDATE',
      porque: 'escrita direta pula o teto de blob e o merge por perfil' },
    { tabela: 'user_data',          coluna: 'data_json', priv: 'INSERT',
      porque: 'idem' },
];

const quebrados = [];
for (const inv of INVARIANTES) {
    const col = schema.get(inv.tabela)?.get(inv.coluna);
    if (!col) {
        quebrados.push({ ...inv, estado: 'COLUNA/TABELA NÃO EXISTE — invariante desatualizado' });
        continue;
    }
    const tem = inv.priv === 'INSERT' ? col.insert : col.update;
    if (tem) quebrados.push({ ...inv, estado: 'CONCEDIDO' });
}

console.log(`\ninvariantes de grant — ${INVARIANTES.length} verificados`);
if (quebrados.length === 0) {
    console.log('✓ nenhum privilégio que já foi fechado voltou a existir');
} else {
    console.log(`✗ ${quebrados.length} invariante(s) violado(s):\n`);
    for (const q of quebrados) {
        console.log(`  [${q.estado}] authenticated tem ${q.priv} em ${q.tabela}.${q.coluna}`);
        console.log(`             ${q.porque}`);
    }
    console.log(`
  Se as migrations de 2026-08-17 ainda não foram aplicadas, é ESPERADO ver
  profiles.is_active e push_subscriptions.endpoint aqui — este é justamente o
  comando que diz se a correção está viva no banco:
      supabase/migrations/20260817000000_sec001_is_active_autoridade_unica.sql
      supabase/migrations/20260817010000_sec002_push_endpoint_allowlist.sql
`);
}

// ── 3. Relatório ─────────────────────────────────────────────────────────────

console.log(`\ncheck-client-columns — ${escritasLidas} escrita(s) analisada(s) em ${ALVOS.length} árvores\n`);

if (problemas.length === 0) {
    console.log('✓ toda coluna escrita existe, e o cliente tem privilégio nas que ele escreve');
} else {
    console.log(`✗ ${problemas.length} problema(s):\n`);
    for (const p of problemas) {
        console.log(`  [${p.tipo}] ${p.tabela}.${p.coluna}  — .${p.op}() em ${p.rel}:${p.linha}`);
    }
    console.log(`
  INEXISTENTE → o PostgREST devolve 42703 e a escrita NÃO ACONTECE. Se houver
                \`console.error\` por perto, o erro vira log e some. Foi assim que
                o enforcement do downgrade ficou quebrado sem ninguém notar.
                Conserto: tirar a coluna do payload (ou criá-la, se era para existir).

  SEM GRANT   → o cliente leva 403. Conserto: GRANT POR COLUNA, nunca GRANT de
                tabela inteira — grant amplo é como \`is_active\` virou escrevível
                pelo navegador (SEC-001).
`);
}

if (naoVerificaveis.length > 0) {
    console.log(`\n⚠️  ${naoVerificaveis.length} escrita(s) que este script NÃO consegue verificar:\n`);
    for (const n of naoVerificaveis) {
        console.log(`  ${n.tabela} .${n.op}() em ${n.rel}:${n.linha}  — ${n.motivo}`);
    }
    console.log(`
  Não são aprovações: são pontos cegos, listados para não virarem verde enganoso.
  Se alguma escrever coluna sensível, prefira literal explícito no lugar da variável.
`);
}

process.exitCode =
    (process.argv.includes('--strict') && (problemas.length || quebrados.length)) ? 1 : 0;
