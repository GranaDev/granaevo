/**
 * check-refs.mjs — chamadas a funções que não existem.
 *
 * POR QUE ESTE SCRIPT EXISTE (2026-07-15):
 * Uma refatoração apagou `_metaIconClass` de db-metas.js enquanto `renderMetaVisual()`
 * ainda a chamava. O build passou VERDE: o rollup trata identificador desconhecido como
 * global do browser e só emite um aviso. Em produção virou ReferenceError em runtime e
 * os botões de adicionar/retirar/ajustar das reservas sumiram para o usuário.
 *
 * Regra: toda função chamada precisa estar declarada no arquivo, importada, ou ser um
 * global conhecido. Sem análise de escopo — coleta TODA declaração do arquivo, em
 * qualquer escopo. Isso deixa passar erro de shadowing, mas nunca deixa passar o caso
 * que motivou o script: a função não existe em lugar nenhum.
 *
 * Uso: node scripts/check-refs.mjs   (sai 1 se achar chamada órfã)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const RAIZ = 'src/scripts';

const GLOBAIS = new Set([
    // JS
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
    'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map',
    'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'parseInt', 'parseFloat',
    'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
    'decodeURI', 'structuredClone', 'queueMicrotask', 'globalThis', 'eval',
    // Browser
    'window', 'document', 'console', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'alert',
    'confirm', 'prompt', 'atob', 'btoa', 'crypto', 'performance', 'matchMedia', 'screen',
    'Image', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
    'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
    'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'Notification',
    'Worker', 'BroadcastChannel', 'TextEncoder', 'TextDecoder', 'CanvasRenderingContext2D',
    'HTMLElement', 'Node', 'NodeList', 'DOMParser', 'getComputedStyle', 'scrollTo', 'open',
    'close', 'print', 'reportError', 'DocumentFragment', 'Element', 'AudioContext',
    'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
    'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'CSSStyleSheet',
    'createImageBitmap', 'OffscreenCanvas', 'SpeechSynthesisUtterance', 'PerformanceObserver',
    'ReadableStream', 'WritableStream', 'CompressionStream', 'DecompressionStream',
    // Do app (UMD carregado sob demanda / injetado)
    'Chart', 'supabase', 'Sentry', 'grecaptcha', 'turnstile', 'workbox', '__vitePreload',
]);

function ler(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) ler(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

function walk(node, cb) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, cb); return; }
    if (typeof node.type === 'string') cb(node);
    for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
        walk(node[k], cb);
    }
}

// Extrai nomes de um padrão de binding: a, {a,b:c}, [a,...b], a = 1
function nomesDoPadrao(no, out) {
    if (!no) return;
    switch (no.type) {
        case 'Identifier': out.add(no.name); break;
        case 'ObjectPattern': for (const p of no.properties) nomesDoPadrao(p.value ?? p.argument, out); break;
        case 'ArrayPattern': for (const el of no.elements) nomesDoPadrao(el, out); break;
        case 'RestElement': nomesDoPadrao(no.argument, out); break;
        case 'AssignmentPattern': nomesDoPadrao(no.left, out); break;
    }
}

let problemas = 0;

for (const arquivo of ler(RAIZ)) {
    const src = fs.readFileSync(arquivo, 'utf8');
    let ast;
    try {
        ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    } catch (e) {
        console.error(`✗ ${arquivo}: não parseou — ${e.message}`);
        problemas++;
        continue;
    }

    const declarados = new Set();
    const chamados = [];
    // `typeof X === 'function'` é o idioma de "pode não existir" — não lança se X não
    // existe, e resolve contra window quando existe. Guardado assim, é intencional.
    const guardados = new Set();

    walk(ast, (no) => {
        switch (no.type) {
            case 'UnaryExpression':
                if (no.operator === 'typeof' && no.argument?.type === 'Identifier') {
                    guardados.add(no.argument.name);
                }
                break;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
                if (no.id) declarados.add(no.id.name);
                for (const p of no.params) nomesDoPadrao(p, declarados);
                break;
            case 'ClassDeclaration':
            case 'ClassExpression':
                if (no.id) declarados.add(no.id.name);
                break;
            case 'VariableDeclarator': nomesDoPadrao(no.id, declarados); break;
            case 'CatchClause': nomesDoPadrao(no.param, declarados); break;
            case 'ImportSpecifier':
            case 'ImportDefaultSpecifier':
            case 'ImportNamespaceSpecifier':
                declarados.add(no.local.name);
                break;
            case 'CallExpression':
            case 'NewExpression':
                if (no.callee?.type === 'Identifier') {
                    chamados.push({ nome: no.callee.name, linha: no.callee.loc.start.line });
                } else if (no.callee?.type === 'MemberExpression' &&
                           no.callee.object?.type === 'Identifier' &&
                           !no.callee.computed) {
                    // `X.metodo()` — o callee é MemberExpression, então a checagem
                    // de Identifier acima não vê o `X`. Sem este ramo, uma constante
                    // inexistente usada como `_MINHA_RE.test(s)` passa batido e só
                    // quebra no navegador. Aconteceu ao escrever este projeto.
                    chamados.push({ nome: no.callee.object.name, linha: no.callee.object.loc.start.line });
                }
                break;
        }
    });

    const orfas = chamados.filter(c =>
        !declarados.has(c.nome) && !GLOBAIS.has(c.nome) && !guardados.has(c.nome));
    if (orfas.length) {
        problemas += orfas.length;
        const vistos = new Set();
        for (const o of orfas) {
            const chave = `${o.nome}:${o.linha}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);
            console.error(`✗ ${arquivo}:${o.linha} — chama '${o.nome}()', que não é declarada nem importada`);
        }
    }
}

if (problemas) {
    console.error(`\n${problemas} chamada(s) órfã(s). Se for um global legítimo, adicione em GLOBAIS.`);
    process.exit(1);
}
console.log('✓ check-refs: nenhuma chamada órfã');
