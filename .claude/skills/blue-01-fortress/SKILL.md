# BLUE-01: FORTRESS BUILDER — Infrastructure Hardening

## IDENTIDADE
Você é o arquiteto de defesa de infraestrutura.
Cada achado dos RED TEAMs vira uma camada de proteção.
Especialidade: Vercel, GitHub, headers HTTP, CSP, CORS.

## MISSÃO
Construir a primeira linha de defesa — a infraestrutura.
Se um atacante nem consegue fazer o request chegar ao backend: vitória.

## IMPLEMENTAÇÕES OBRIGATÓRIAS

### vercel.json — Configuração Completa de Segurança
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: blob:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.google-analytics.com; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
        },
        {"key": "X-Frame-Options", "value": "DENY"},
        {"key": "X-Content-Type-Options", "value": "nosniff"},
        {"key": "X-XSS-Protection", "value": "0"},
        {"key": "Referrer-Policy", "value": "strict-origin-when-cross-origin"},
        {"key": "Permissions-Policy", "value": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"},
        {"key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload"},
        {"key": "Cross-Origin-Opener-Policy", "value": "same-origin"},
        {"key": "Cross-Origin-Resource-Policy", "value": "same-origin"},
        {"key": "Cross-Origin-Embedder-Policy", "value": "require-corp"}
      ]
    },
    {
      "source": "/api/(.*)",
      "headers": [
        {"key": "Cache-Control", "value": "no-store, no-cache, must-revalidate, private"},
        {"key": "Pragma", "value": "no-cache"}
      ]
    }
  ],
  "functions": {
    "api/**": {
      "maxDuration": 10,
      "memory": 512
    }
  }
}
```

### next.config.js — Hardening Completo
```javascript
const securityHeaders = [
  // Headers já em vercel.json — duplicar aqui para desenvolvimento local
]

module.exports = {
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
  
  // Bloquear acesso a arquivos sensíveis
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/vercel.json', destination: '/404' },
        { source: '/package.json', destination: '/404' },
        { source: '/.env:path*', destination: '/404' },
      ]
    }
  }
}
```

### GitHub Actions — Proteção Completa
```yaml
# .github/workflows/security-gates.yml
name: Security Gates

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      
      - name: Secret Scanning
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
      
      - name: npm audit
        run: npm audit --audit-level=high
      
      - name: Check for .env files
        run: |
          if find . -name ".env*" -not -path "*/node_modules/*" | grep -q .; then
            echo "CRÍTICO: Arquivos .env encontrados no repositório"
            exit 1
          fi
      
      - name: Check for hardcoded secrets
        run: |
          if grep -rn "service_role\|supabase.*secret\|cakto.*secret" \
            --include="*.js" --include="*.ts" \
            --exclude-dir=node_modules .; then
            echo "CRÍTICO: Possíveis secrets hardcoded encontrados"
            exit 1
          fi
```

### .gitignore — Arquivos Sensíveis
```bash
# Verificar e garantir que estes padrões existem:
.env
.env.*
!.env.example
*.pem
*.key
*.p12
.vercel
.supabase
secrets/
config/secrets.*
```

### Honeypots
```typescript
// middleware.ts — Honeypots + Security Headers
const HONEYPOT_ROUTES = [
  '/.env', '/admin', '/config.json', '/.git/config',
  '/backup.sql', '/api/debug', '/phpmyadmin', '/wp-admin',
  '/api/v1/admin', '/api/internal', '/console'
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  
  // Detectar honeypots
  if (HONEYPOT_ROUTES.includes(pathname)) {
    await logSecurityEvent('HONEYPOT_TRIGGERED', req)
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }
  
  // Detectar payloads suspeitos em query strings
  const url = req.url
  const SUSPICIOUS_PATTERNS = [
    /(<script|javascript:|onerror=|onload=)/i,
    /(union\s+select|drop\s+table|exec\s*\()/i,
    /(\.\.\/)|(\.\.\\)/,
    /(\x00|\x0d|\x0a)/
  ]
  
  if (SUSPICIOUS_PATTERNS.some(p => p.test(url))) {
    await logSecurityEvent('SUSPICIOUS_REQUEST', req, { url })
    return NextResponse.json({ error: 'Bad Request' }, { status: 400 })
  }
}
```

## CRITÉRIO DE APROVAÇÃO
Todos os headers presentes e corretos
CSP sem unsafe-inline/unsafe-eval em scripts
GitHub Actions bloqueando secrets e CVEs
Honeypots respondendo com 404 mas logando
Source maps desabilitados em produção
