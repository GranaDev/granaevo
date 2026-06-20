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
 *   import { initErrorTracking, captureError, setUserContext } from './error-tracking.js';
 *   initErrorTracking();
 *   setUserContext({ id: user.id, email: user.email, plan: user.plano });
 */

// DSN configurado via variável de ambiente Vite (VITE_ prefixo = exposto no bundle)
// Em produção: vercel env add VITE_SENTRY_DSN production
const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN ?? null;
const IS_PROD    = import.meta.env?.PROD === true;

/** @type {boolean} true se Sentry está configurado e ativo */
let _initialized = false;

/** @type {any} Referência ao objeto Sentry (carregado lazy) */
let _Sentry = null;

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

  try {
    // Importação lazy — Sentry é grande (~200KB), não bloquear o parse inicial
    const Sentry = await import('@sentry/browser');
    _Sentry = Sentry;

    Sentry.init({
      dsn: SENTRY_DSN,
      environment:          'production',
      release:              import.meta.env?.VITE_APP_VERSION ?? '1.0.0',

      // Captura 100% dos erros mas apenas 10% das transações de performance
      // (performance tracking tem custo — ajuste conforme volume)
      tracesSampleRate:     0.1,

      // Não enviar eventos com dados pessoais sensíveis
      beforeSend(event) {
        // Remove dados de autenticação dos eventos (PII)
        if (event.request) {
          delete event.request.cookies;
          if (event.request.headers) delete event.request.headers['authorization'];
        }
        // Remove breadcrumbs de XHR/fetch para /api/ (podem conter tokens).
        // SDK v8+: event.breadcrumbs é um array (Breadcrumb[]) — NÃO { values: [] }
        // como era no v7. Usar .values aqui pegava o iterador nativo do Array e
        // quebrava no .filter (TypeError) — derrubando todo o envio de eventos.
        if (Array.isArray(event.breadcrumbs)) {
          event.breadcrumbs = event.breadcrumbs.filter(b => {
            if (b.type === 'http' && b.data?.url?.includes('/api/')) return false;
            return true;
          });
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

      // Integrações mínimas (sem rastreamento de performance para reduzir overhead)
      // Sentry v8+: browserTracingIntegration() (função), não mais new BrowserTracing()
      integrations: [
        Sentry.browserTracingIntegration({
          // Não rastrear requests para Supabase (dados financeiros sensíveis)
          shouldCreateSpanForRequest: (url) => !url.includes('supabase.co'),
        }),
      ],
    });

    _initialized = true;
    console.info('[ErrorTracking] Sentry inicializado em produção.');
  } catch (err) {
    // Falha silenciosa — rastreamento de erros não deve quebrar a aplicação
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

/**
 * Define o contexto do usuário no Sentry (após login bem-sucedido).
 * Não inclui dados financeiros — apenas identificador e plano.
 * @param {{ id: string, email?: string, plan?: string }} user
 */
export function setUserContext(user) {
  if (!_initialized || !_Sentry) return;
  _Sentry.setUser({
    id:    user.id,
    // Hash do email para não expor PII diretamente no Sentry
    email: user.email ? `${user.email.slice(0, 3)}***@***.***` : undefined,
    plan:  user.plan ?? 'unknown',
  });
}

/**
 * Limpa o contexto do usuário (no logout).
 */
export function clearUserContext() {
  if (!_initialized || !_Sentry) return;
  _Sentry.setUser(null);
}

/**
 * Captura uma mensagem de nível info/warning para rastreamento.
 * @param {string} message
 * @param {'info'|'warning'|'error'} [level='info']
 */
export function captureMessage(message, level = 'info') {
  if (!_initialized || !_Sentry) return;
  _Sentry.captureMessage(message, level);
}
