/**
 * Cliente S3 mínimo para Cloudflare R2 — assinatura SigV4 em Node puro.
 *
 * POR QUE NÃO O @aws-sdk/client-s3:
 * o pacote e suas dependências passam de 15 MB para usarmos quatro verbos
 * (LIST, PUT, HEAD, DELETE) contra um bucket só. Este projeto tem 5 dependências
 * de produção e a disciplina de não crescer sem motivo. SigV4 é um algoritmo
 * fechado e determinístico: ou a assinatura bate e o R2 responde 200, ou não bate
 * e responde 403. Não existe meio-termo silencioso, então o risco de uma
 * implementação própria aqui é baixo e aparece na primeira execução.
 *
 * Credenciais por variável de ambiente, nunca em arquivo:
 *   CLOUDFLARE_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY
 */
import { createHash, createHmac } from 'node:crypto';

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac      = (k, d) => createHmac('sha256', k).update(d).digest();

/** true quando as três variáveis existem — deixa o chamador degradar sem quebrar. */
export function r2Configurado() {
    return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID
        && process.env.R2_ACCESS_KEY_ID
        && process.env.R2_SECRET_ACCESS_KEY);
}

function credenciais() {
    const acct   = process.env.CLOUDFLARE_ACCOUNT_ID;
    const key    = process.env.R2_ACCESS_KEY_ID;
    const secret = process.env.R2_SECRET_ACCESS_KEY;
    if (!acct || !key || !secret) throw new Error('credenciais do R2 ausentes no ambiente');
    return { acct, key, secret, host: `${acct}.r2.cloudflarestorage.com` };
}

/**
 * Monta os headers assinados de uma requisição.
 *
 * A região é literalmente `auto` no R2 — não é placeholder. E o
 * `x-amz-content-sha256` é obrigatório: o R2 recusa a requisição sem ele,
 * mesmo em GET com corpo vazio.
 */
function assinar({ method, path, query, payload, host, key, secret }) {
    const amzDate  = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateOnly = amzDate.slice(0, 8);
    const payloadHash = sha256hex(payload);

    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders    = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const scope        = `${dateOnly}/auto/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateOnly), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}

async function requisitar(method, path, { query = '', payload = Buffer.alloc(0), timeout = 300_000 } = {}) {
    const { host, key, secret } = credenciais();
    const headers = assinar({ method, path, query, payload, host, key, secret });
    const r = await fetch(`https://${host}${path}${query ? '?' + query : ''}`, {
        method, headers,
        body: (method === 'PUT' || method === 'POST') ? payload : undefined,
        signal: AbortSignal.timeout(timeout),
    });
    return r;
}

/** Envia um objeto. Devolve o ETag (MD5 do conteúdo, para conferência). */
export async function r2Put(bucket, chave, corpo) {
    const r = await requisitar('PUT', `/${bucket}/${chave}`, { payload: corpo });
    if (!r.ok) throw new Error(`PUT ${chave}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (r.headers.get('etag') ?? '').replaceAll('"', '');
}

/** Tamanho do objeto remoto, ou null se não existir. */
export async function r2Tamanho(bucket, chave) {
    const r = await requisitar('HEAD', `/${bucket}/${chave}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HEAD ${chave}: HTTP ${r.status}`);
    return Number(r.headers.get('content-length') ?? 0);
}

/** Lista as chaves do bucket (com prefixo opcional), já ordenadas. */
export async function r2Listar(bucket, prefixo = '') {
    const chaves = [];
    let token = '';
    do {
        const query = ['list-type=2', 'max-keys=1000',
            prefixo ? `prefix=${encodeURIComponent(prefixo)}` : '',
            token ? `continuation-token=${encodeURIComponent(token)}` : '',
        ].filter(Boolean).join('&');
        const r = await requisitar('GET', `/${bucket}`, { query });
        if (!r.ok) throw new Error(`LIST: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) chaves.push(m[1]);
        token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? '';
    } while (token);
    return chaves.sort();
}

/** Remove um objeto. */
export async function r2Apagar(bucket, chave) {
    const r = await requisitar('DELETE', `/${bucket}/${chave}`);
    // 204 é o sucesso normal; 404 também serve — o alvo já não está lá.
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
        throw new Error(`DELETE ${chave}: HTTP ${r.status}`);
    }
}
