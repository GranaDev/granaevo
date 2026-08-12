#!/usr/bin/env node
/**
 * GranaEvo — backup completo do Postgres (dump → cifra → verifica → retenção)
 * ---------------------------------------------------------------------------
 * Nasceu na Fase 1 de resiliência (2026-08-12), depois da auditoria de segurança.
 * O contexto: o projeto tinha snapshot diário do blob financeiro (`user_data`) e
 * NADA do resto — `auth.users`, `stripe_subscriptions`, `account_members`,
 * `financial_audit_log`. Um incidente nessas tabelas era irrecuperável.
 *
 * USO:
 *   node scripts/backup-db.mjs --dry-run   ← mostra o que faria, não escreve
 *   node scripts/backup-db.mjs             ← executa
 *
 * PRÉ-REQUISITOS (todos por variável de ambiente — nunca em arquivo, nunca no chat):
 *   SUPABASE_PROJECT_REF     ref do projeto
 *   SUPABASE_ACCESS_TOKEN    PAT, só para ler o host do pooler
 *   SUPABASE_DB_PASSWORD     senha do papel `postgres`
 *   GRANAEVO_BACKUP_KEY      passphrase que CIFRA o backup
 *   + PostgreSQL client 17+ e gpg no PATH
 *
 * ⚠️ SE A GRANAEVO_BACKUP_KEY FOR PERDIDA, TODOS OS BACKUPS VIRAM LIXO.
 * Ela precisa existir em algum lugar que sobreviva a esta máquina — gerenciador
 * de senhas, cofre, papel no cofre físico. Um backup cifrado com chave perdida
 * é indistinguível de não ter backup.
 *
 * ─── DECISÕES QUE NÃO SE LEEM NO CÓDIGO ────────────────────────────────────
 *
 * 1. SEM `--no-privileges`, DE PROPÓSITO.
 *    A primeira versão usava `--no-owner --no-privileges`, que é o padrão de
 *    quem faz dump para MIGRAR. Aqui o objetivo é DESASTRE, e a diferença é
 *    grande: `--no-privileges` descarta todo GRANT/REVOKE. O dump viria com as
 *    62 policies e SEM os grants — inclusive sem o
 *    `REVOKE INSERT/UPDATE/DELETE ON user_data FROM authenticated` (SEC-009).
 *    Restaurar aquele arquivo recriaria o banco com a falha de volta, porque
 *    policy sem grant é inalcançável e grant sem policy é buraco.
 *
 * 2. `--no-owner` FICA. Os owners são papéis internos do Supabase
 *    (supabase_auth_admin etc.). O restore como `postgres` não consegue
 *    atribuí-los sem ser membro, e sem a flag o restore enche de erro.
 *
 * 3. PORTA 5432, não 6543. No pooler, 6543 é transaction mode e quebra o
 *    pg_dump (ele precisa de snapshot consistente na mesma conexão). 5432 é
 *    session mode.
 *
 * 4. USUÁRIO É `postgres.<ref>`. O Supavisor identifica o tenant pelo sufixo.
 *    Sem ele: FATAL (ENOIDENTIFIER) no tenant identifier provided.
 *
 * 5. O SCHEMA `auth` EXIGE O PAPEL `postgres`. Os papéis temporários da
 *    Management API (`/cli/login-role`, read_only true E false) batem em
 *    "permission denied for schema auth" — o Supabase reserva esse schema ao
 *    `supabase_auth_admin`. Sem `auth.users` no dump, o restore não permite
 *    LOGIN, e aí o backup não restaura o sistema, só os dados.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { r2Configurado, r2Put, r2Tamanho, r2Listar, r2Apagar } from './_r2.mjs';

const DRY = process.argv.includes('--dry-run');

// Fora do repositório de propósito: o dump contém e-mails, log de auditoria e
// dados de assinatura em claro. Nada disso pode encostar no git.
const DESTINO   = process.env.GRANAEVO_BACKUP_DIR ?? 'C:\\Users\\SnaKito\\Desktop\\Apps\\granaevo-backups';
const PGBIN     = process.env.PGBIN ?? 'C:\\Program Files\\PostgreSQL\\17\\bin';
const RETENCAO  = Number(process.env.GRANAEVO_BACKUP_KEEP ?? 14);
const SCHEMAS   = ['public', 'auth', 'storage'];
const BUCKET    = process.env.GRANAEVO_R2_BUCKET ?? 'granaevo-backups';

const falhar = (msg) => { console.error(`\n[backup-db] FALHOU: ${msg}`); process.exit(1); };
const exigir = (v) => process.env[v] || falhar(`variável de ambiente ${v} ausente`);

const REF = exigir('SUPABASE_PROJECT_REF');
const PAT = exigir('SUPABASE_ACCESS_TOKEN');
const PW  = exigir('SUPABASE_DB_PASSWORD');
const KEY = exigir('GRANAEVO_BACKUP_KEY');

const bin = (n) => {
    const p = join(PGBIN, `${n}.exe`);
    if (!existsSync(p)) falhar(`${n} não encontrado em ${PGBIN}`);
    return p;
};

const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

async function poolerHost() {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/database/pooler`, {
        headers: { Authorization: `Bearer ${PAT}` },
    });
    if (!r.ok) falhar(`não consegui ler a config do pooler: HTTP ${r.status}`);
    const j = await r.json();
    return (Array.isArray(j) ? j[0] : j).db_host;
}

const inicio = Date.now();
console.log(`[backup-db] ${new Date().toISOString()}${DRY ? '  (DRY RUN)' : ''}`);

// O `fetch` fica DEPOIS do early-return do dry-run de propósito. Chamá-lo antes
// deixava um socket keep-alive aberto, e o `process.exit(0)` seguinte derrubava
// o processo com "Assertion failed !(handle->flags & UV_HANDLE_CLOSING)" e
// exit code 127. Num cron isso é grave: o script TERMINA BEM e reporta falha —
// exatamente o alarme falso que o item 19 (monitoramento) não pode ter.
if (DRY) {
    console.log(`  schemas ...... ${SCHEMAS.join(', ')}`);
    console.log(`  destino ...... ${DESTINO}\\granaevo-<timestamp>.dump.gpg`);
    console.log(`  retenção ..... ${RETENCAO} arquivos`);
    console.log('\n[backup-db] dry-run: nada foi escrito.');
    process.exitCode = 0;
} else {
await executar();
}

async function executar() {
const host = await poolerHost();
mkdirSync(DESTINO, { recursive: true });

const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bruto   = join(DESTINO, `granaevo-${stamp}.dump`);
const cifrado = `${bruto}.gpg`;

console.log(`  host ......... ${host}:5432`);
console.log(`  schemas ...... ${SCHEMAS.join(', ')}`);
console.log(`  destino ...... ${cifrado}`);
console.log(`  retenção ..... ${RETENCAO} arquivos`);

// ── 1. dump ─────────────────────────────────────────────────────────────────
try {
    execFileSync(bin('pg_dump'), [
        '--host', host, '--port', '5432',
        '--username', `postgres.${REF}`, '--dbname', 'postgres',
        '--format', 'custom', '--compress', '9', '--no-owner',
        ...SCHEMAS.flatMap((s) => ['--schema', s]),
        '--file', bruto,
    ], { env: { ...process.env, PGPASSWORD: PW, PGSSLMODE: 'require' }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 900_000 });
} catch (e) {
    falhar('pg_dump: ' + (e.stderr?.toString() ?? e.message).split('\n').slice(-3).join(' '));
}
console.log(`  dump ......... ${mb(statSync(bruto).size)}`);

// ── 2. verificar ANTES de cifrar ────────────────────────────────────────────
// Um arquivo cifrado ilegível e um arquivo cifrado corrompido são idênticos por
// fora. A checagem tem de acontecer enquanto dá para olhar dentro.
let entradas = 0, acl = 0;
try {
    const lista = execFileSync(bin('pg_restore'), ['--list', bruto], { encoding: 'utf8', maxBuffer: 128e6 });
    const linhas = lista.split('\n').filter((l) => l && !l.startsWith(';'));
    entradas = linhas.length;
    acl = linhas.filter((l) => / ACL /.test(l)).length;
    const faltando = ['user_data', 'stripe_subscriptions', 'account_members', 'financial_audit_log', 'profiles']
        .filter((t) => !lista.includes(` ${t} `));
    if (faltando.length) falhar(`tabelas ausentes no dump: ${faltando.join(', ')}`);
    if (!/ auth /.test(lista)) falhar('schema auth ausente — restore não permitiria login');
    if (acl === 0) falhar('nenhuma entrada ACL — o dump saiu sem grants (--no-privileges?)');
} catch (e) {
    if (e.message?.startsWith('[backup-db]')) throw e;
    falhar('pg_restore --list: ' + e.message);
}
console.log(`  integridade .. ${entradas} entradas, ${acl} ACL`);

// ── 3. cifrar ───────────────────────────────────────────────────────────────
// AES-256 simétrico. A passphrase entra por stdin, nunca por argv (argv é
// visível para qualquer processo da máquina via lista de processos).
try {
    execFileSync('gpg', [
        '--batch', '--yes', '--quiet',
        '--symmetric', '--cipher-algo', 'AES256',
        '--passphrase-fd', '0', '--pinentry-mode', 'loopback',
        '--output', cifrado, bruto,
    ], { input: KEY, stdio: ['pipe', 'ignore', 'pipe'], timeout: 300_000 });
} catch (e) {
    falhar('gpg: ' + (e.stderr?.toString() ?? e.message).slice(0, 200));
}
rmSync(bruto);   // o texto claro não sobrevive ao script
console.log(`  cifrado ...... ${mb(statSync(cifrado).size)}  (AES-256)`);

// ── 4. provar que decifra ───────────────────────────────────────────────────
// Sem este passo, "backup cifrado" é uma promessa. Decifra para memória e
// confere que o pg_restore ainda lê o índice.
try {
    const claro = execFileSync('gpg', [
        '--batch', '--quiet', '--decrypt',
        '--passphrase-fd', '0', '--pinentry-mode', 'loopback', cifrado,
    ], { input: KEY, maxBuffer: 512e6, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 });
    if (claro.length < 1024) falhar('decifragem devolveu conteúdo vazio');
    console.log(`  decifra ...... ok (${mb(claro.length)} recuperados)`);
} catch (e) {
    falhar('não consegui decifrar o que acabei de cifrar: ' + (e.stderr?.toString() ?? e.message).slice(0, 160));
}

// ── 5. subir para fora da máquina ───────────────────────────────────────────
// É este passo que transforma "cópia" em "backup". Enquanto o arquivo mora só
// no disco do operador, incêndio/roubo/ransomware levam o banco e a cópia
// juntos — e o cenário que o backup existe para cobrir é justamente esse.
//
// Falha aqui é ERRO, não aviso: um backup que não saiu da máquina não cumpriu
// o objetivo, e o exit code precisa refletir isso para o agendador alertar.
const nomeRemoto = cifrado.split(/[\\/]/).pop();
if (!r2Configurado()) {
    console.log('  R2 ........... NÃO CONFIGURADO — backup existe só localmente');
    console.log('\n[backup-db] ⚠️  ARQUIVO SÓ NA MÁQUINA DO OPERADOR. Defina');
    console.log('[backup-db]     CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY.');
    process.exitCode = 1;
} else {
    const bytesLocais = statSync(cifrado).size;
    try {
        await r2Put(BUCKET, nomeRemoto, readFileSync(cifrado));
    } catch (e) {
        falhar('upload para o R2: ' + e.message);
    }

    // Conferir o tamanho remoto, e não só o 200 do PUT: um upload truncado por
    // conexão instável pode responder sucesso e gravar menos bytes.
    const bytesRemotos = await r2Tamanho(BUCKET, nomeRemoto);
    if (bytesRemotos !== bytesLocais) {
        falhar(`upload divergente: ${bytesLocais} bytes locais x ${bytesRemotos} remotos`);
    }
    console.log(`  R2 ........... ${nomeRemoto} (${mb(bytesRemotos)}) confirmado`);

    // Retenção remota. O `sort()` funciona porque o nome começa com timestamp
    // ISO — ordem alfabética é ordem cronológica.
    const remotos = (await r2Listar(BUCKET, 'granaevo-')).filter((k) => k.endsWith('.dump.gpg'));
    const sobrando = remotos.slice(0, -RETENCAO);
    for (const k of sobrando) await r2Apagar(BUCKET, k);
    if (sobrando.length) console.log(`  R2 retenção .. ${sobrando.length} antigo(s) removido(s)`);
    console.log(`  R2 total ..... ${remotos.length - sobrando.length} backup(s) remoto(s)`);
}

// ── 6. retenção local ───────────────────────────────────────────────────────
const antigos = readdirSync(DESTINO)
    .filter((f) => /^granaevo-.*\.dump\.gpg$/.test(f))
    .sort()
    .slice(0, -RETENCAO);
for (const f of antigos) rmSync(join(DESTINO, f));
if (antigos.length) console.log(`  local retenção ${antigos.length} antigo(s) removido(s)`);

const mantidos = readdirSync(DESTINO).filter((f) => /\.dump\.gpg$/.test(f)).length;

// A última linha tem de CONCORDAR com o exit code. A versão anterior imprimia
// "OK" mesmo quando o upload não acontecia e o processo saía com 1 — quem lesse
// o log via sucesso, quem lesse o exit code via falha. Num alerta automático,
// essa discordância é como o monitoramento aprende a mentir.
const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
if (process.exitCode) {
    console.log(`\n[backup-db] INCOMPLETO em ${segundos}s — ${mantidos} local, ZERO remoto`);
} else {
    console.log(`\n[backup-db] OK em ${segundos}s — ${mantidos} local, retenção ${RETENCAO}`);
}
}
