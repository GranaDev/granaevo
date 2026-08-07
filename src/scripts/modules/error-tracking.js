/**
 * @module error-tracking
 * @description Integração com Sentry para rastreamento de erros em produção.
 *
 * Para ativar:
 * 1. Crie uma conta em https://sentry.io e crie um projeto JavaScript
 * 2. Copie o DSN do projeto
 * 3. Defina a variável de ambiente VITE_SENTRY_DSN no Vercel:
 *    vercel env add VITE_SENTRY_DSN production
 * 4. O Sentry só rastreia erros em produção (NODE_ENV=production)
 *
 * Uso nas páginas:
 *   import { initErrorTracking, setUserContext } from './error-tracking.js';
 *   initErrorTracking();
 *   setUserContext({ id: user.id, plan: user.plano });   // NUNCA passar e-mail
 *
 * O QUE SAI DAQUI (e o que não sai)
 *   Sai: tipo e mensagem do erro (peneirada), stack, navegador, um pseudônimo
 *        não reversível do id e o nome do plano.
 *   NÃO sai: e-mail, UUID real, valores em R$, nome de transação, saldo, token,
 *        cookie, query string de URL. Ver `_limpar` e `_semQuery` abaixo.
 *   Sem tracing e sem sessão: só erro. O Sentry é operador nos EUA (declarado em
 *   privacidade.html §04/§05 e no RoPA) — o que sai daqui não volta.
 *
 * SEM `VITE_SENTRY_DSN` o módulo é inerte: `initErrorTracking()` retorna na
 * primeira linha e o bundler descarta o resto. Não é erro, é o estado padrão.
 */

// DSN configurado via variável de ambiente Vite (VITE_ prefixo = exposto no bundle)
// Em produção: vercel env add VITE_SENTRY_DSN production
const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN ?? null;
const IS_PROD    = import.meta.env?.PROD === true;

// ── Peneira de conteúdo (LGPD) ──────────────────────────────────────────────
// Aplicada a TODO texto que sai: mensagem do evento, valor da exceção e
// mensagem de breadcrumb. Ordem importa — e-mail antes de número, senão o
// trecho numérico de um endereço vira "[num]" e o e-mail escapa da 1ª regra.
const RE_EMAIL    = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const RE_DINHEIRO = /r\$\s*[\d.,]+/gi;
// 6+ dígitos seguidos (com separadores) é valor, id ou documento — nunca algo
// que ajude a depurar. Números curtos ("linha 42", "status 500") passam.
const RE_NUM_LONGO = /\b\d[\d.,]{5,}\b/g;

/**
 * Troca dinheiro, e-mail e números longos por rótulos.
 * Exportada porque é a garantia de LGPD do módulo: precisa de teste que exercite
 * o código de verdade, não uma reconstrução das regexes a partir do texto-fonte.
 */
export function _limpar(txt) {
  if (typeof txt !== 'string') return txt;
  return txt
    .replace(RE_EMAIL, '[email]')
    .replace(RE_DINHEIRO, '[valor]')
    .replace(RE_NUM_LONGO, '[num]');
}

/** Remove query string e hash: é onde viajam token, `next=` e id de perfil. */
export function _semQuery(url) {
  if (typeof url !== 'string') return url;
  const corte = url.search(/[?#]/);
  return corte === -1 ? url : url.slice(0, corte);
}

/** @type {boolean} true se Sentry está configurado e ativo */
let _initialized = false;

/** @type {any} Referência ao objeto Sentry (carregado lazy) */
let _Sentry = null;

// ── Rede de segurança enquanto o SDK não chegou ─────────────────────────────
// O SDK do Sentry pesa ~132 KB gzip. Baixá-lo durante o boot faria o vigia
// competir por banda com a aplicação que ele deveria vigiar — num celular em
// 4G isso é atraso perceptível numa tela de dinheiro.
//
// Mas adiar tem um custo próprio: os erros do início — justamente os piores,
// os que quebram a tela antes de qualquer coisa aparecer — aconteceriam antes
// de haver quem os escutasse, e sumiriam.
//
// Então as duas coisas: dois listeners baratos entram AGORA e guardam o que
// aparecer; o SDK entra quando o navegador estiver ocioso e recebe a fila.
const _fila = [];
const FILA_MAX = 10;   // um loop de erro não pode virar vazamento de memória
let _ouvindo = false;

function _enfileirar(err) {
  if (_fila.length < FILA_MAX) _fila.push(err);
}
const _onErro   = (e) => _enfileirar(e.error ?? new Error(String(e.message ?? 'erro')));
const _onRejeic = (e) => _enfileirar(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));

function _ouvirDesdeJa() {
  if (_ouvindo) return;
  _ouvindo = true;
  window.addEventListener('error', _onErro);
  window.addEventListener('unhandledrejection', _onRejeic);
}

/** Devolve os listeners-ponte ao SDK e despeja a fila nele. */
function _entregarFila() {
  window.removeEventListener('error', _onErro);
  window.removeEventListener('unhandledrejection', _onRejeic);
  _ouvindo = false;
  for (const err of _fila.splice(0)) {
    try { _Sentry.captureException(err); } catch { /* não vale derrubar o app por telemetria */ }
  }
}

/** Espera o navegador ficar ocioso — com teto, porque aba em segundo plano nunca fica. */
function _quandoOcioso() {
  return new Promise((r) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout: 5000 });
    else setTimeout(r, 2000);
  });
}

/**
 * Inicializa o rastreamento de erros.
 * Só ativa em produção com DSN configurado.
 * Carrega o Sentry de forma assíncrona para não bloquear o carregamento inicial.
 */
export async function initErrorTracking() {
  if (!IS_PROD || !SENTRY_DSN) {
    if (!IS_PROD) {
      console.info('[ErrorTracking] Desativado em desenvolvimento.');
    } else {
      console.warn('[ErrorTracking] VITE_SENTRY_DSN não configurado. ' +
        'Adicione via: vercel env add VITE_SENTRY_DSN production');
    }
    return;
  }

  _ouvirDesdeJa();       // a rede entra antes de qualquer await
  await _quandoOcioso(); // o SDK só depois que a aplicação respirou

  try {
    // Importação lazy — Sentry é grande (~132 KB gzip), não bloquear o boot
    const Sentry = await import('@sentry/browser');
    _Sentry = Sentry;

    Sentry.init({
      dsn: SENTRY_DSN,
      environment:          'production',
      release:              import.meta.env?.VITE_APP_VERSION ?? '1.0.0',

      // SÓ ERRO. Nada de performance, nada de sessão.
      //
      // O código antigo dizia, no comentário das integrações, "sem rastreamento
      // de performance para reduzir overhead" — e logo abaixo ligava o
      // browserTracing com 10% de amostragem. A configuração contradizia a
      // própria intenção declarada.
      //
      // Aqui a escolha é explícita: tracing manda URL de cada navegação e cada
      // request para um terceiro nos EUA, o que num app de finanças é dado a
      // mais viajando em troca de quase nada. Sessão idem. O que se quer é
      // saber que alguém quebrou — e isso o Sentry captura sozinho, via
      // window.onerror e unhandledrejection, sem integração nenhuma.
      autoSessionTracking:  false,
      sendDefaultPii:       false,   // explícito: o padrão do SDK já é false, mas isto é contrato

      // Não enviar eventos com dados pessoais sensíveis
      beforeSend(event) {
        // Remove dados de autenticação dos eventos (PII)
        if (event.request) {
          delete event.request.cookies;
          if (event.request.headers) delete event.request.headers['authorization'];
          if (event.request.url) event.request.url = _semQuery(event.request.url);
        }
        // Remove breadcrumbs de XHR/fetch para /api/ (podem conter tokens).
        // SDK v8+: event.breadcrumbs é um array (Breadcrumb[]) — NÃO { values: [] }
        // como era no v7. Usar .values aqui pegava o iterador nativo do Array e
        // quebrava no .filter (TypeError) — derrubando todo o envio de eventos.
        if (Array.isArray(event.breadcrumbs)) {
          event.breadcrumbs = event.breadcrumbs
            .filter(b => !(b.type === 'http' && b.data?.url?.includes('/api/')))
            .map(b => {
              if (b.message) b.message = _limpar(b.message);
              if (b.data?.url) b.data.url = _semQuery(String(b.data.url));
              return b;
            });
        }

        // ── Ruído do registro de service worker ──────────────────────────────
        // O `registerSW.js` é GERADO pelo VitePWA e faz
        // `navigator.serviceWorker.register(...)` sem `.catch()`. Quando o
        // registro falha — robô de busca, aba anônima, armazenamento bloqueado —
        // sai uma rejeição não tratada com a mensagem inútil "Rejected".
        //
        // O 1º caso real (2026-08-04) veio do `Google-Read-Aloud`, um robô do
        // Google: nenhum usuário afetado. E a falha é inofensiva — sem service
        // worker o app funciona igual, só perde o modo offline.
        //
        // TROCA CONSCIENTE: perdemos visibilidade sobre falhas de registro em
        // troca de um painel que não cria ruído. Se um dia importar medir isso,
        // o certo é `injectRegister: null` no vite.config e registrar com catch
        // — não desfazer este filtro, que só esconde o sintoma.
        const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
        if (frames.some((f) => String(f?.filename ?? '').includes('registerSW.js'))) return null;

        // ── A peneira que faltava: o TEXTO do erro ───────────────────────────
        // Tudo acima limpa envelope (cookies, headers, URLs). Nada limpava o
        // conteúdo — e é ali que o dinheiro aparece. Uma exceção deste app pode
        // nascer com a frase inteira dentro: "falha ao salvar R$ 1.234,56" ou
        // "usuário fulano@email.com não encontrado". O Sentry é um operador nos
        // EUA: o que sai daqui não volta.
        if (event.message) event.message = _limpar(event.message);
        for (const ex of event.exception?.values ?? []) {
          if (ex.value) ex.value = _limpar(ex.value);
        }
        return event;
      },

      // Ignora erros esperados (rede offline, extensões do browser, etc.)
      ignoreErrors: [
        'Network request failed',
        'NetworkError',
        'Failed to fetch',
        'Load failed',
        'ResizeObserver loop limit exceeded',
        /^Script error/,
        /extension:\/\//,
      ],

      // Nenhuma integração extra: só os handlers globais de erro que o SDK já
      // instala. Menos código baixado e menos dado saindo — ver o bloco acima.
      integrations: [],

      // Erro vindo de extensão do navegador não é bug nosso e enche o painel.
      denyUrls: [/extensions?\//i, /^chrome:\/\//i, /^moz-extension:\/\//i],
    });

    _initialized = true;
    _entregarFila();   // o que quebrou durante o boot chega junto
    console.info('[ErrorTracking] Sentry inicializado em produção.');
  } catch (err) {
    // Falha silenciosa — rastreamento de erros não deve quebrar a aplicação.
    // A ponte é desarmada: sem SDK, guardar erro numa fila que ninguém lê só
    // consumiria memória e seguraria referências de objetos já mortos.
    window.removeEventListener('error', _onErro);
    window.removeEventListener('unhandledrejection', _onRejeic);
    _fila.length = 0;
    _ouvindo = false;
    console.warn('[ErrorTracking] Falha ao inicializar Sentry:', err.message);
  }
}

/**
 * Captura um erro manualmente (para try/catch em pontos críticos).
 * @param {Error|unknown} error    - Erro capturado
 * @param {Record<string, any>} [context] - Contexto adicional
 */
export function captureError(error, context = {}) {
  if (!_initialized || !_Sentry) {
    console.error('[ErrorTracking] Erro capturado (Sentry inativo):', error, context);
    return;
  }
  _Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
    _Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

// Pseudônimo estável e NÃO reversível a partir do id do usuário (FNV-1a → hex).
// Objetivo: permitir AGRUPAR erros do mesmo usuário no Sentry sem enviar o UUID
// real (que é dado pessoal) nem o e-mail. O Sentry não possui a lista de UUIDs,
// então este valor não permite reidentificar o titular.
function _pseudoId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Define o contexto do usuário no Sentry (após login bem-sucedido).
 * PRIVACIDADE (LGPD): NÃO enviamos o UUID real nem o e-mail ao Sentry — apenas um
 * pseudônimo derivado (não reversível) para agrupar erros, e o plano. Nenhum dado
 * financeiro é enviado. Ver privacidade.html §04/§05 (operador Sentry).
 * @param {{ id: string, email?: string, plan?: string }} user
 */
export function setUserContext(user) {
  if (!_initialized || !_Sentry) return;
  _Sentry.setUser({
    id:   user?.id ? `anon_${_pseudoId(String(user.id))}` : undefined,
    plan: user?.plan ?? 'unknown',
  });
}

/**
 * Limpa o contexto do usuário. Chamado pelo `logout()` do supabase-client —
 * ponto único de saída. Sem isto, o pseudônimo de quem saiu continuaria colado
 * nos erros de quem usar o mesmo aparelho depois (conta de casal/família).
 */
export function clearUserContext() {
  if (!_initialized || !_Sentry) return;
  _Sentry.setUser(null);
}
