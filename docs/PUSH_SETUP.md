# Configuração Web Push (VAPID)

## Gerar chaves VAPID

```bash
npx web-push generate-vapid-keys
```

Isso gera:
- `VAPID_PUBLIC_KEY` — vai em `.env` como `VITE_VAPID_PUBLIC_KEY` (pode ser pública)
- `VAPID_PRIVATE_KEY` — vai em Supabase Secrets (NUNCA expor)

## Variáveis necessárias

### Vercel (via dashboard ou CLI)
```
VITE_VAPID_PUBLIC_KEY=sua_chave_publica_aqui
```

### Supabase Secrets (supabase secrets set)
```
VAPID_PRIVATE_KEY=sua_chave_privada_aqui
VAPID_SUBJECT=mailto:admin@granaevo.com
```

## Deploy da migração

```bash
supabase db push
```

## Deploy das Edge Functions

```bash
supabase functions deploy save-push-subscription
supabase functions deploy delete-push-subscription
```
