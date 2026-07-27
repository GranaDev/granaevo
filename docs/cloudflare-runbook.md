# Cloudflare — runbook de cutover e configuração (B-2 · B-3)

**Estado hoje (verificado em 2026-07-27):** o Cloudflare **não está no caminho**.
Os nameservers de `granaevo.com` são `ns1/ns2.dns-parking.com` (Hostinger) e nenhum
host devolve `cf-ray` — o tráfego vai direto para a Vercel.

> ⚠️ O comentário no topo de `index.html` afirma que *"o Cloudflare injeta
> beacon.min.js automaticamente via proxy"*. **Isso está desatualizado.** A CSP
> libera `static.cloudflareinsights.com` e `cloudflareinsights.com` para nada —
> é superfície aberta sem uso. Ou se conclui este runbook, ou se remove da CSP.

Tudo que dá para automatizar está em `scripts/cloudflare-setup.mjs`.
Os passos abaixo são os que **só você** pode fazer.

---

## 1. Adicionar o site e trocar os nameservers

1. https://dash.cloudflare.com → **Add a site** → `granaevo.com` → plano **Free**.
2. O Cloudflare importa os registros DNS atuais. **Confira um por um** antes de
   seguir — em especial:
   - `www` e `@` apontando para a Vercel
   - `assistente` (subdomínio do PWA)
   - **MX e TXT do ImprovMX/Resend** — se estes se perderem, o e-mail de
     `privacidade@`, `suporte@` e `contato@` para de funcionar, e junto vai o
     canal de titular da LGPD.
3. No Hostinger, troque os nameservers para os dois que o Cloudflare mostrar.
4. Propagação: minutos a algumas horas. A zona sai de `pending` para `active`.

**Proxy (nuvem laranja):** ligue para `@`, `www` e `assistente`.
Deixe **cinza** (DNS only) os registros de e-mail — passar MX pelo proxy quebra
a entrega.

**Janela de risco:** durante a propagação, parte dos usuários resolve pelo DNS
antigo e parte pelo novo. Ambos apontam para a Vercel, então não há queda — só
não faça a troca junto com um deploy grande.

---

## 2. Token de API

https://dash.cloudflare.com/profile/api-tokens → **Create Token** → Custom.

Permissões mínimas:

| Escopo | Permissão |
|---|---|
| Zone → Zone Settings | Edit |
| Zone → Zone | Edit |
| Zone → Firewall Services | Edit |
| Zone → Zone WAF | Edit |
| Account → Turnstile | Edit |

Restrinja a **Specific zone → granaevo.com**.

```powershell
setx CLOUDFLARE_API_TOKEN "seu-token-aqui"
```

Reabra o terminal. **O token não entra em arquivo versionado nem é colado em
chat** — mesma regra do `SUPABASE_ACCESS_TOKEN`.

---

## 3. Rodar a configuração

```bash
node scripts/cloudflare-setup.mjs --dry-run   # confere o que vai fazer
node scripts/cloudflare-setup.mjs             # aplica
```

Idempotente: rodar de novo dá o mesmo resultado.

### O que ele aplica

| Área | Configuração |
|---|---|
| TLS | Full **(strict)**, Always HTTPS, min TLS 1.2, TLS 1.3, HSTS 2 anos + preload |
| Bots | Bot Fight Mode, Browser Integrity Check, Security Level medium |
| Scrape Shield | Email obfuscation, hotlink protection |
| Rede | WebSockets (o Realtime do Supabase precisa), Brotli, **0-RTT off** |
| Cache | Respeita o `Cache-Control` da Vercel; **`/api/*` em bypass explícito** |
| Firewall | 5 regras (o teto do free) |
| Rate limit | 1 regra: `/api/auth-session`, 10 req/10s por IP — **é o B-3** |
| DNSSEC | Habilitado no Cloudflare (falta publicar o DS no Hostinger) |

### Por que `0-RTT` fica **desligado**
0-RTT deixa o cliente reenviar dados no primeiro pacote do handshake. Isso
permite **replay** de requisição — inaceitável num app onde um POST repetido
grava dinheiro duas vezes.

### Por que `Always Online` fica **desligado**
Ele serve uma cópia velha da página quando a origem cai. Num app financeiro,
mostrar saldo desatualizado como se fosse atual é pior do que mostrar erro.

---

## 4. Turnstile — o B-2

O script não cria o widget porque a chave precisa ser colada em dois lugares.

1. Dashboard → **Turnstile** → Add site
   - Domains: `granaevo.com`, `www.granaevo.com`, `assistente.granaevo.com`
   - Widget mode: **Managed**
2. Guarde as duas chaves:
   - **Site key** (pública) → `VITE_TURNSTILE_SITE_KEY` nas env da Vercel
   - **Secret key** → `TURNSTILE_SECRET_KEY` nas env da Vercel (privada)
3. Me avise que eu troco o reCAPTCHA pelo Turnstile em `login.js`,
   `api/verify-recaptcha.js` e na CSP (`frame-src`/`script-src` passam a apontar
   para `challenges.cloudflare.com` em vez do Google).

### Enquanto o Turnstile não entra
O reCAPTCHA atual é acionado por um contador em `localStorage` — quem chama
`/api/auth-session` direto **nunca o vê**. O que hoje segura força bruta é o
lockout por conta (S-2, já em produção) e o limite por IP. O Turnstile fecha o
caso do bot que resolve captcha barato.

---

## 5. Sobre a dor de cabeça de cache que você teve antes

Foi por isso que o Turnstile ficou parado no Passo 26. O que muda agora:

1. **`/api/*` tem regra de bypass explícita** — não depende de heurística.
2. **`browser_cache_ttl = 0`** faz o Cloudflare respeitar o `Cache-Control` que
   a Vercel já manda (`no-store` nas rotas autenticadas, `immutable` nos assets
   com hash). O `vercel.json` já está correto; o problema antigo era o
   Cloudflare sobrescrevendo isso.
3. **Sempre que publicar**, se desconfiar de cache: Dashboard → Caching →
   **Purge Everything**. Com assets versionados por hash, purgar é barato.
4. **Development Mode** (Caching → Development Mode) desliga o cache por 3h —
   use durante um deploy que mexa em HTML.

---

## 6. Depois de aplicar, confira

```bash
# passou a ter cf-ray? (antes: nenhum host tinha)
curl -sI https://www.granaevo.com | grep -i "cf-ray\|server"

# /api/* NÃO pode vir cacheado — cf-cache-status deve ser DYNAMIC ou BYPASS
curl -sI https://www.granaevo.com/api/auth-session | grep -i "cf-cache-status"

# o app continua funcionando de ponta a ponta
#   login → dashboard carrega → lançar uma transação → sino → assistente
```

Se algo quebrar, o rollback é imediato e total: **volte os nameservers para
`ns1/ns2.dns-parking.com` no Hostinger**. O tráfego deixa de passar pelo
Cloudflare e nada mais muda.
