// /api/csp-report.js — Recebe violações de CSP e loga estruturado
// Permite que o browser reporte violações sem expor nenhum dado sensível.

const MAX_BODY_BYTES = 4096  // relatórios CSP são pequenos

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    return res.status(405).end()
  }

  const ct = req.headers['content-type'] ?? ''
  if (!ct.includes('application/csp-report') && !ct.includes('application/json')) {
    return res.status(415).end()
  }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      req.on('data', chunk => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch {
    return res.status(413).end()
  }

  let report
  try {
    const parsed = JSON.parse(raw)
    report = parsed['csp-report'] ?? parsed
  } catch {
    return res.status(400).end()
  }

  // Log estruturado — sem dados de usuário, apenas a violação de política
  console.warn(JSON.stringify({
    ts:               new Date().toISOString(),
    level:            'warn',
    event:            'csp_violation',
    blocked_uri:      report['blocked-uri']       ?? report.blockedURI       ?? 'unknown',
    violated:         report['violated-directive'] ?? report.violatedDirective ?? 'unknown',
    effective:        report['effective-directive'] ?? report.effectiveDirective ?? 'unknown',
    document_uri:     report['document-uri']       ?? report.documentURI       ?? 'unknown',
    referrer:         report['referrer']            ?? report.referrer           ?? '',
    status_code:      report['status-code']         ?? report.statusCode         ?? 0,
    source_file:      report['source-file']         ?? report.sourceFile         ?? '',
    line:             report['line-number']          ?? report.lineNumber          ?? 0,
  }))

  return res.status(204).end()
}
