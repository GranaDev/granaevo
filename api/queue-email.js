/**
 * /api/queue-email.js — Fila assíncrona de emails via Upstash QStash
 *
 * Uso interno: outros proxies chamam este endpoint em vez de chamar
 * as Edge Functions de email diretamente. O QStash garante:
 *  - Entrega com retry automático (até 3 tentativas)
 *  - Desacoplamento: a requisição retorna imediato, o email é enviado em background
 *  - Rate limiting natural via filas
 *
 * Variáveis de ambiente necessárias:
 *   QSTASH_TOKEN       — Token do QStash (Upstash Console)
 *   QSTASH_CURRENT_SIGNING_KEY — Para verificar assinatura das callbacks
 *   SUPABASE_URL       — URL do projeto Supabase
 *   SUPABASE_ANON_KEY  — Anon key do Supabase
 *
 * Sem QSTASH_TOKEN, o endpoint envia o email de forma síncrona (fallback).
 */

import { checkRate } from './_rate-limit.js'

const QSTASH_TOKEN  = process.env.QSTASH_TOKEN
const SUPABASE_URL  = process.env.SUPABASE_URL  ?? ''
const ANON_KEY      = process.env.SUPABASE_ANON_KEY ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'https://granaevo.com'

const EMAIL_FUNCTIONS = {
  'welcome':        `${SUPABASE_URL}/functions/v1/send-welcome-email`,
  'reset-code':     `${SUPABASE_URL}/functions/v1/send-password-reset-code`,
  'guest-invite':   `${SUPABASE_URL}/functions/v1/send-guest-invite`,
}

const RATE_MAX = 5 // emails por IP por minuto

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  const origin = req.headers['origin'] ?? ''
  // Permite chamadas internas (sem origin) e do domínio permitido
  if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })
  if (!SUPABASE_URL || !ANON_KEY) return res.status(503).json({ error: 'Serviço indisponível' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`queue-email:${ip}`, RATE_MAX))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > 4096) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) { return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' }) }

  let body; try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  const type = body?.type
  if (!type || !EMAIL_FUNCTIONS[type]) {
    return res.status(400).json({ error: `type inválido. Use: ${Object.keys(EMAIL_FUNCTIONS).join(', ')}` })
  }

  const targetUrl  = EMAIL_FUNCTIONS[type]
  const { type: _t, ...payload } = body
  const payloadStr = JSON.stringify(payload)

  // ── Modo QStash: envio assíncrono com retry ───────────────────────────────
  if (QSTASH_TOKEN) {
    try {
      const qRes = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(targetUrl)}`, {
        method:  'POST',
        headers: {
          'Authorization':  `Bearer ${QSTASH_TOKEN}`,
          'Content-Type':   'application/json',
          'Upstash-Forward-Authorization': `Bearer ${ANON_KEY}`,
          'Upstash-Forward-apikey':        ANON_KEY,
          'Upstash-Retries': '3',
          'Upstash-Delay':   '0s',
        },
        body: payloadStr,
        signal: AbortSignal.timeout(8_000),
      })
      if (!qRes.ok) throw new Error(`QStash HTTP ${qRes.status}`)
      return res.status(202).json({ queued: true, type })
    } catch (err) {
      // QStash falhou — fallback para envio síncrono
      console.error('[queue-email] QStash error, falling back:', err?.message)
    }
  }

  // ── Fallback: envio síncrono direto ──────────────────────────────────────
  try {
    const r = await fetch(targetUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
      body:    payloadStr,
      signal:  AbortSignal.timeout(15_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
}
