# Plano de Resposta a Incidentes de Segurança / Vazamento de Dados
**Controlador:** GranaEvo · **Base:** LGPD art. 48 · **Versão:** 1.0 — 2026-07-07
**Responsável:** privacidade@granaevo.com

> Documento interno. Objetivo: reagir rápido e corretamente a incidentes com dados pessoais,
> e cumprir o dever de comunicar a ANPD e os titulares em prazo razoável (art. 48).

## O que conta como incidente
Qualquer evento que possa comprometer confidencialidade, integridade ou disponibilidade de dados
pessoais: vazamento, acesso indevido, perda/corrupção de dados, ransomware, vazamento de secret
(service_role, STRIPE_SECRET, ANTHROPIC_API_KEY, PROXY_SECRET, DATA_ENCRYPTION_KEY), exploração de
vulnerabilidade, ou falha que exponha dados de um usuário a outro.

## Fluxo em 5 passos

### 1. DETECTAR e registrar (imediato)
- Fontes: alertas do Sentry, `cron-health-alert`, logs do Supabase/Vercel, relato de usuário, aviso de terceiro.
- Abrir um registro no **Registro de Incidentes** (seção abaixo) com data/hora, quem detectou, o que se sabe.

### 2. CONTER (primeiras horas)
- Vazou secret? **Revogar/rotacionar imediatamente** (ver `SECURITY.md` e o passo a passo de rotação). Ex.:
  regenerar service_role no Supabase, `STRIPE_SECRET_KEY` no Stripe, `ANTHROPIC_API_KEY`, `PROXY_SECRET`.
- Acesso indevido a conta? Revogar sessões do(s) usuário(s) afetado(s).
- Falha explorável? Desabilitar o endpoint/feature afetada (feature_flag) até corrigir.
- Preservar evidências (logs) antes de qualquer limpeza.

### 3. AVALIAR o risco
- Quais dados? Quantos titulares? Dado financeiro/sensível envolvido? Estava cifrado?
- Classificar gravidade: **Baixa** (sem exposição real / dado cifrado inacessível) · **Média** (exposição limitada) · **Alta** (dado pessoal exposto a terceiro, risco a titulares).

### 4. NOTIFICAR (se risco relevante — art. 48)
- **ANPD:** comunicar em prazo razoável (referência da ANPD: até ~3 dias úteis da ciência) via canal oficial gov.br/anpd. Incluir: natureza dos dados, titulares afetados, medidas técnicas, riscos, medidas adotadas/propostas.
- **Titulares afetados:** e-mail claro (o que aconteceu, quais dados, o que fazer — ex.: trocar senha, revisar Stripe), sem juridiquês.
- **Guardar prova** das comunicações.

### 5. CORRIGIR e aprender
- Aplicar correção definitiva (migration/patch); rodar `/god-mode`/`/god-eyes` na área afetada.
- Post-mortem curto: causa-raiz, como evitar recorrência, o que melhorar na detecção.
- Fechar o registro do incidente.

## Contatos e recursos
- **ANPD:** gov.br/anpd · **Encarregado:** privacidade@granaevo.com
- **Rotação de secrets:** `SECURITY.md` · **Auditoria:** `/god-mode`, `/god-eyes`
- **Backups/recuperação:** snapshots diários cifrados (`user_data_snapshots`, 5d) + backups de perfil (90d).

## Registro de Incidentes (append-only)
| Data/hora | Detectado por | Descrição | Dados/titulares | Gravidade | ANPD notificada? | Titulares notificados? | Correção | Status |
|---|---|---|---|---|---|---|---|---|
| _(sem incidentes registrados)_ | | | | | | | | |

## Histórico de revisões
| Data | Versão | Mudança |
|---|---|---|
| 2026-07-07 | 1.0 | Criação (God Eyes / remediação LGPD). |
