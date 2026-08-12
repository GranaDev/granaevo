#!/usr/bin/env node
/**
 * GranaEvo — verificação pós-correção da configuração da Vercel.
 *
 * USO:  node scripts/verificar-vercel.mjs      (precisa de VERCEL_TOKEN)
 *
 * NÃO é auditoria: é conferência de 8 pontos específicos, decididos na
 * auditoria de 2026-08-12. Só leitura, nada é alterado.
 *
 * ─── O QUE A AUDITORIA ACHOU ────────────────────────────────────────────────
 * 7 previews PÚBLICOS (HTTP 200), Deployment Protection desligada, e credencial
 * privilegiada de produção com o alvo Preview marcado.
 *
 * Estava inexplorável, mas por ACIDENTE: `api/_rate-limit.js` faz throw no
 * import quando `IS_PRODUCTION && !USE_REDIS`, e na Vercel `NODE_ENV=production`
 * vale também em preview. Toda rota api/ do preview devolvia 500. Ligar o
 * UPSTASH em Preview, ou pôr RATE_LIMIT_STRICT=false, reabriria tudo.
 *
 * Vulnerabilidade que depende de um crash para ficar fechada não está fechada.
 *
 * ─── PÚBLICO x PRIVILEGIADO ─────────────────────────────────────────────────
 * A primeira versão do relatório tratou os 7 compartilhamentos como iguais.
 * Não são, e a distinção evita política exagerada que quebra preview à toa:
 *
 *   PÚBLICO (pode ficar em Preview)   SUPABASE_URL, VITE_TURNSTILE_SITE_KEY
 *      — os dois estão hardcoded em src/scripts/services/supabase-client.js
 *        e viajam no bundle; tirá-los do env não esconde nada.
 *
 *   PRIVILEGIADO (não pode)           RESEND_API_KEY, TURNSTILE_SECRET_KEY,
 *                                     PROXY_SECRET, DATA_ENCRYPTION_KEY,
 *                                     UPSTASH_*, CRON_SECRET
 */
import { readFileSync } from 'node:fs';

const TOK = process.env.VERCEL_TOKEN;
if (!TOK) { console.error('VERCEL_TOKEN ausente no ambiente.'); process.exit(2); }

const proj = JSON.parse(readFileSync(new URL('../.vercel/project.json', import.meta.url)));
const PROJ = proj.projectId, TEAM = proj.orgId;

const api = async (path) => {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.vercel.com${path}${sep}teamId=${TEAM}`, {
        headers: { Authorization: `Bearer ${TOK}` },
    });
    const t = await r.text();
    try { return { ok: r.ok, status: r.status, j: JSON.parse(t) }; }
    catch { return { ok: r.ok, status: r.status, j: t }; }
};

const alvos = (v) => (Array.isArray(v.target) ? v.target : [v.target].filter(Boolean));
const resultados = [];
const checar = (nome, passou, detalhe) => {
    resultados.push({ nome, passou });
    console.log(`  ${passou ? 'ok   ' : 'FALHA'}  ${nome.padEnd(50)} ${detalhe}`);
};

console.log('[verificar-vercel] conferência pós-correção\n');

// ── env vars ────────────────────────────────────────────────────────────────
const env = await api(`/v9/projects/${PROJ}/env`);
if (!env.ok) { console.error(`  não consegui ler as variáveis: HTTP ${env.status}`); process.exit(2); }
const vars = env.j.envs ?? env.j;
const emPreview = (nome) => vars.some((v) => v.key === nome && alvos(v).includes('preview'));

checar('1. RESEND_API_KEY fora do Preview', !emPreview('RESEND_API_KEY'),
    emPreview('RESEND_API_KEY') ? 'AINDA em Preview — envia e-mail como GranaEvo' : 'ausente');

checar('2. TURNSTILE_SECRET_KEY fora do Preview', !emPreview('TURNSTILE_SECRET_KEY'),
    emPreview('TURNSTILE_SECRET_KEY') ? 'AINDA em Preview' : 'ausente');

checar('5. PROXY_SECRET segue ausente do Preview', !emPreview('PROXY_SECRET'),
    emPreview('PROXY_SECRET') ? 'APARECEU em Preview — barreira principal caiu' : 'ausente (barreira intacta)');

// ── 6. varredura: nenhuma credencial privilegiada em Preview ────────────────
// Lista de NOMES, não de padrões: `SUPABASE_URL` e `VITE_*_SITE_KEY` são
// públicos e casariam num regex ingênuo, gerando alarme falso e política
// exagerada. Só entra aqui o que concede poder de verdade.
const PRIVILEGIADAS = [
    'RESEND_API_KEY', 'TURNSTILE_SECRET_KEY', 'PROXY_SECRET', 'DATA_ENCRYPTION_KEY',
    'CRON_SECRET', 'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
    'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY',
    'R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'SUPABASE_DB_PASSWORD',
];
const vazando = PRIVILEGIADAS.filter(emPreview);
checar('6. nenhuma credencial privilegiada em Preview', vazando.length === 0,
    vazando.length ? `VAZANDO: ${vazando.join(', ')}` : `${PRIVILEGIADAS.length} nomes conferidos`);

// ── 3. deployment protection ────────────────────────────────────────────────
const p = await api(`/v9/projects/${PROJ}`);
const prot = Boolean(p.j.ssoProtection || p.j.passwordProtection || p.j.trustedIps);
checar('3. Deployment Protection ativa', prot,
    prot ? `sso=${JSON.stringify(p.j.ssoProtection?.deploymentType ?? null)}` : 'nenhuma proteção');

// ── 4. previews antigos removidos ───────────────────────────────────────────
let todos = [], until = null;
for (let i = 0; i < 20; i++) {
    const r = await api(`/v6/deployments?projectId=${PROJ}&limit=100${until ? `&until=${until}` : ''}`);
    if (!r.ok) break;
    const lote = r.j.deployments ?? [];
    todos.push(...lote);
    if (lote.length < 100) break;
    until = lote[lote.length - 1].created - 1;
}
// Paginar é obrigatório: os previews da auditoria eram de junho/julho e ficavam
// FORA dos 100 mais recentes. Amostragem aqui responderia "nenhum preview".
const previews = todos.filter((d) => d.target !== 'production');
checar('4. previews antigos removidos', previews.length === 0,
    previews.length ? `${previews.length} restante(s) de ${todos.length} deployments` : `0 de ${todos.length}`);

// ── 8. um preview novo herdaria credencial privilegiada? ────────────────────
// Não cria deployment: pergunta ao estado de configuração, que é o que decide
// o que um preview futuro recebe.
checar('8. preview futuro não herda privilégio', vazando.length === 0,
    vazando.length ? 'herdaria: ' + vazando.join(', ') : 'a config atual não concede nada privilegiado');

// ── 7. produção continua no ar ──────────────────────────────────────────────
let prodOk = false, prodStatus = '?';
try {
    const r = await fetch('https://www.granaevo.com/login', { signal: AbortSignal.timeout(20_000) });
    prodStatus = r.status; prodOk = r.status === 200;
} catch (e) { prodStatus = e.name; }
checar('7. produção continua funcionando', prodOk, `https://www.granaevo.com/login -> ${prodStatus}`);

// ── veredito ────────────────────────────────────────────────────────────────
const falhas = resultados.filter((r) => !r.passou).length;
console.log('');
if (falhas) {
    console.log(`[verificar-vercel] ${falhas} de ${resultados.length} pendente(s).`);
    process.exit(1);
}
console.log(`[verificar-vercel] APROVADO — ${resultados.length} checagens passaram.`);
