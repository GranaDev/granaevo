# Passo a passo — o que VOCÊ (dev) ainda precisa fazer
**Contexto:** remediação dos achados LGPD do /god-mode + /god-eyes (2026-07-07).
Eu (Claude) já fiz as partes de código/documento. Aqui está o que só você pode fazer,
em ordem de prioridade, com o "porquê" de cada passo.

> ⚠️ ORDEM IMPORTA: assine os DPAs (Passo 2) **antes ou junto** de publicar a nova política
> (Passo 4). A política já afirma que existem DPAs firmados — então o texto precisa ser verdade.

---

## ✅ O que JÁ está feito (por mim, no repositório)
- `privacidade.html` reescrita: assistente de IA (Anthropic), Sentry, transferência internacional (EUA), foto (correção), prazo 15 dias (art. 19), criptografia por usuário.
- `src/scripts/modules/error-tracking.js`: Sentry **não envia mais UUID real nem e-mail** — só um pseudônimo não reversível + plano.
- `supabase/functions/delete-account/index.ts`: Edge Function de exclusão de conta (self-service).
- `api/user-data.js`: rota `action:"delete-account"` no proxy (com rate limit e confirmação por e-mail).
- **`dashboard.html` + `db-configuracoes.js`: botão "Excluir minha conta"** em Configurações → Zona de Perigo, com modal que exige digitar o e-mail, chama a API, faz logout e redireciona. **PRONTO** — só falta deploy (Passo 3).
- `docs/compliance/RoPA.md` e `plano-resposta-incidentes.md`: documentos exigidos pela LGPD (art. 37 e 48).

---

## PASSO 1 — Sentry: manter SEM reter dados do usuário (DECIDIDO) ✅ (config do painel FEITA em 2026-07-12)
Sua decisão: **manter o Sentry, mas sem reter dados dos usuários.** No **código já está feito**
(o Sentry não recebe mais UUID real nem e-mail — só um pseudônimo não reversível + o plano).
Config do painel concluída em 2026-07-12 (nível organização, vale p/ todos os projetos):
Require Data Scrubber + Require Using Default Scrubbers + Prevent Storing of IP Addresses **ligados**,
e Global Sensitive Fields = cpf/email/senha/token/telefone/nome. **DPA do Sentry firmado em 2026-07-12 (v5.1.0) + PDF salvo. Sentry 100% ✅.**
1. **Data Scrubbing (server-side):** ✅ FEITO — Org Settings → **Security & Privacy** → seção
   *Data Scrubbing*: 3 toggles ligados + campos sensíveis preenchidos.
2. **Retenção:** o Sentry tem retenção fixa por plano (erros ~90 dias no plano gratuito/Team; não
   dá pra zerar). Como não enviamos mais PII, o que fica retido são stack traces sem identificar
   ninguém — alinhado com "sem reter dados do usuário".
3. **(Opcional, recomendado) Região UE:** transferir pra UE é "destino adequado" na LGPD (mais limpo
   que EUA). No Sentry, crie/migre a organização para **região EU** e troque o **DSN** (`...de.sentry.io...`);
   atualize `VITE_SENTRY_DSN` no Vercel.
   - **DECISÃO 2026-07-12: NÃO migrar.** Já estamos conformes via **SCCs** em todos os DPAs (EUA + SCCs = válido, LGPD art. 33). Sentry não guarda mais PII (ganho ~zero); migrar Supabase seria arriscar um banco em produção. Esforço/risco não compensam. Mantido EUA + SCCs.
4. Assinar o **DPA do Sentry** (Passo 2).

---

## PASSO 2 — Assinar os DPAs (≈1h, uma vez) ✅ CONCLUÍDO em 2026-07-12 (todos firmados + PDFs salvos; ZDR Anthropic = retenção padrão)
**Por quê:** é o escudo legal da transferência internacional (art. 33). Reduz seu risco, não aumenta.
Não tem custo e é documento padrão. Guarde uma cópia (PDF/print) de cada — é sua prova pra ANPD.

Marque no `docs/compliance/DPAs.md` conforme concluir:

1. **Anthropic (o mais importante — é o dado financeiro em texto):**
   - Entre em console.anthropic.com → **Settings/Legal** (ou "Data Processing Addendum" / Trust Center).
   - Aceite/baixe o DPA. Se não houver botão, escreva para o suporte/privacy da Anthropic pedindo o DPA.
   - **Peça Zero Data Retention (ZDR)** para sua API (ou confirme a retenção padrão). Isso faz a Anthropic não guardar as mensagens.
2. **Sentry:** Organization Settings → Legal/Compliance → aceitar **DPA**. (E o Passo 1b se for pra UE.)
3. **Supabase:** Dashboard → Organization → Legal/Compliance → confirmar **DPA** ativo.
4. **Stripe:** Dashboard → Settings → Legal/Compliance → confirmar **DPA** (geralmente já aceito nos termos).
5. **Vercel:** Account/Team → Settings → Legal → confirmar **DPA**.
6. **Cloudflare:** Dashboard → conta → confirmar **DPA** (Cloudflare aplica DPA por padrão).
7. **Google reCAPTCHA / Resend:** confirmar termos de tratamento de dados.

> A maioria (Supabase/Stripe/Vercel/Cloudflare) já vem com DPA aplicado nos Termos — só confirmar.
> Os que exigem ação real de verdade: **Anthropic** (e ZDR) e **Sentry**.

---

## PASSO 3 — Publicar a Edge Function de exclusão de conta (10 min) ✅ DEPLOY FEITO em 2026-07-12
**Por quê:** direito de eliminação self-service (LGPD art. 18, VI) — hoje só existe por e-mail.

1. Fazer deploy da função (ela já está no repo):
   ```bash
   supabase functions deploy delete-account --no-verify-jwt
   ```
   (usa `--no-verify-jwt` porque a auth é própria: proxy-secret + `auth.getUser` interno, igual às outras.)
2. Ela usa os secrets que já existem (`SUPABASE_SERVICE_ROLE_KEY`, `PROXY_SECRET`) — nada novo a configurar.
3. Testar (com uma conta de teste!):
   **[✅ 2026-07-12: deploy feito + smoke test OK — POST sem x-proxy-secret → 401 unauthorized (PROXY_SECRET presente). O teste DESTRUTIVO completo (criar conta descartável e excluir pela UI) deve ser feito DEPOIS do Passo 5, quando o botão entra no ar.]**
   - Logado, chamar `POST /api/user-data` com corpo `{ "action":"delete-account", "confirmEmail":"<email-da-conta-de-teste>" }`.
   - Esperado: `200 { ok:true, deleted:true }`, e a conta some do Supabase (Auth + todos os dados por cascata).
   - E-mail errado → `400 confirm_mismatch`. Sem login → `401`.

> ⚠️ É destrutivo e irreversível. Teste SÓ com conta descartável antes de expor na UI.

---

## PASSO 4 — Botão "Excluir minha conta" na UI ✅ FEITO
Implementado em **Configurações → Zona de Perigo** (`dashboard.html` + `db-configuracoes.js`):
botão vermelho, modal que exige **digitar o e-mail da conta** para habilitar, aviso de assinatura
ativa, chamada ao `action:"delete-account"`, logout e redirecionamento para o login.
Nada a fazer aqui além de publicar (o deploy da Edge Function no Passo 3 é o que falta para funcionar).
Ícone `fa-user-slash` entra no subset automaticamente no `prebuild` (`npm run build`).

---

## PASSO 5 — Publicar a nova política (5 min) 🔴 (depois do Passo 2)
1. Revisar `privacidade.html` (principalmente §04, §05, §02 "Assistente por IA").
   - **Anthropic (confirmado 2026-07-12):** DPA já vale via Commercial Terms + **SCCs**; ZDR é só enterprise → aceita **retenção padrão de até 30 dias (só segurança, não treino)**. A política NÃO promete ZDR (ok). *Melhoria opcional:* acrescentar uma frase em §04/§05 dizendo essa retenção de 30d da Anthropic, pra transparência total.
2. Deploy normal (git push → Vercel).
3. **Comunicar aos usuários** a atualização (a própria política promete aviso por e-mail p/ mudanças relevantes; incluir IA + Sentry conta como relevante). Um e-mail curto "atualizamos nossa Política de Privacidade" resolve.

---

## PASSO 6 — Nomear o Encarregado (DPO) (2 min) ✅ CONCLUÍDO em 2026-07-12
A ANPD aceita canal por e-mail p/ pequenos agentes, mas o ideal é nomear uma **pessoa**.
- ✅ Encarregado = **"Equipe GranaEvo"** em `privacidade.html §01` e `RoPA.md §1` (agente de pequeno porte — canal nos termos da Res. CD/ANPD nº 2/2022; dispensada pessoa natural).
- ✅ **E-mails reais criados (2026-07-12):** `privacidade@`, `suporte@`, `contato@granaevo.com` → encaminham p/ `contatogranaevo@gmail.com` via **ImprovMX** (grátis, MX+SPF no Hostinger). Resposta profissional "enviar como @granaevo.com" via **Resend SMTP** no Gmail (chave `gmail-send-as`). Filtro anti-spam criado no Gmail. Domínio segue Hostinger DNS → Vercel (Cloudflare avaliado e descartado).

---

## PASSO 7 — (Opcional, baixo) Atestação de maioridade no cadastro 🟢
A política diz "18+", mas não há checagem. Adicionar um checkbox "Declaro ter 18 anos ou mais"
no signup fecha o art. 14. Posso implementar se quiser.

---

## Resumo do que depende de você
| Prioridade | Ação | Tempo |
|---|---|---|
| ✅ | Passo 2 — TODOS os DPAs firmados + PDFs salvos (2026-07-12); ZDR Anthropic = retenção padrão | — |
| 🟡 | Passo 3 — deploy **FEITO** ✅ + smoke test OK (2026-07-12); teste destrutivo c/ conta descartável = após Passo 5 | — |
| 🔴 | Passo 5 — publicar política + avisar usuários (após DPAs) | 10 min |
| ✅ | Passo 1 — Sentry: Data Scrubbing no painel **FEITO** (2026-07-12); falta só DPA (Passo 2) | — |
| ✅ | Passo 6 — DPO "Equipe GranaEvo" + e-mails criados (ImprovMX/Resend) **FEITO** (2026-07-12) | — |
| 🟢 | Passo 7 — checkbox 18+ (opcional) | 5 min |
| ✅ | Passo 4 — botão de exclusão na UI: **FEITO** | — |
