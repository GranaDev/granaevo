// ----------------------------------------------------------------------------
// turnstile-state.js — estado de UM widget Turnstile (login, código, cadastro)
//
// POR QUE EXISTE COMO MÓDULO
// Nasceu dentro do `login.js`, onde já servia a dois widgets (o do login e o da
// tela de código). Ao chegar o terceiro — o do cadastro, noutra página e noutro
// bundle — havia duas saídas: copiar, ou extrair.
//
// Copiar sairia caro por um motivo concreto e já vivido neste projeto: a
// invariante mais importante daqui (callbacks vão como FUNÇÃO, nunca como nome)
// custou um bug em produção onde o desafio da Cloudflare passava, o widget dizia
// "Sucesso!", e o login mesmo assim recusava — pedindo um captcha que o usuário
// acabara de resolver. Uma cópia divergente reintroduz isso em silêncio, numa
// tela diferente, meses depois. Já aconteceu aqui com o cálculo de fatura em
// três lugares e com as cópias de `graficos.js`.
//
// Este módulo é SÓ ESTADO. O `render()` fica em cada página, porque é lá que
// mora a diferença de verdade: o login revela o widget só quando o SERVIDOR
// exige, o cadastro precisa dele sempre.
// ----------------------------------------------------------------------------

/** Token do Turnstile expira em ~2 min; 110s deixa margem para o POST chegar. */
export const CAPTCHA_TOKEN_MAX_AGE_MS = 110_000;
/** Token real do Turnstile tem centenas de chars — abaixo disto é lixo. */
export const CAPTCHA_TOKEN_MIN_LENGTH = 50;

/**
 * Cria o estado de um widget.
 *
 * @param {object} opts
 * @param {() => (string|number|null)} opts.getWidgetId  Id devolvido pelo `turnstile.render()`.
 * @param {string} [opts.resolvedCallbackName]  Nome global opcional (contrato de HTML legado).
 * @param {string} [opts.expiredCallbackName]
 * @param {string} [opts.errorCallbackName]
 */
export function createCaptchaState({
    getWidgetId,
    resolvedCallbackName,
    expiredCallbackName,
    errorCallbackName,
} = {}) {
    let _token      = null;
    let _resolved   = false;
    let _resolvedAt = 0;
    let _active     = false;

    const aoResolver = (token) => {
        if (!_active) return;
        if (typeof token !== 'string' || token.length < CAPTCHA_TOKEN_MIN_LENGTH) return;
        if (typeof turnstile === 'undefined') return;
        try {
            // Confere com o widget: aceitar o token que chegou no argumento, sem
            // cruzar com `getResponse`, deixaria qualquer script da página
            // marcar o captcha como resolvido chamando a global.
            const widgetId = getWidgetId();
            const widgetResponse = turnstile.getResponse(widgetId ?? undefined);
            if (!widgetResponse || widgetResponse !== token) return;
            _token = token; _resolved = true; _resolvedAt = Date.now();
        } catch {
            _token = null; _resolved = false; _resolvedAt = 0;
        }
    };

    const aoLimpar = () => { _token = null; _resolved = false; _resolvedAt = 0; };

    // Globais só quando a página pedir: o `login.html` as cita e elas são o
    // contrato daquela tela. Telas novas (cadastro) não precisam — passam os
    // `handlers` direto pro render e não sujam o `window`.
    if (typeof window !== 'undefined') {
        if (resolvedCallbackName) window[resolvedCallbackName] = aoResolver;
        if (expiredCallbackName)  window[expiredCallbackName]  = aoLimpar;
        if (errorCallbackName)    window[errorCallbackName]    = aoLimpar;
    }

    return {
        // ⚠️ O Turnstile exige FUNÇÃO, não nome de função.
        //
        // O reCAPTCHA aceitava `callback: 'nomeDaGlobal'` — uma string — e
        // resolvia o nome sozinho. O Turnstile não: ele guarda o que recebe e
        // depois faz `s.call(...)`. Com uma string aquilo vira
        // `TypeError: s.call is not a function`, lançado LÁ DENTRO do api.js.
        //
        // O sintoma era cruel: o desafio da Cloudflare passava e o widget
        // mostrava "Sucesso!", mas o callback morria antes de marcar o token
        // aqui — então `isResolved()` seguia falso e o envio era recusado,
        // pedindo um captcha que o usuário acabara de resolver.
        //
        // Passe SEMPRE estas referências ao `turnstile.render()`.
        handlers: { resolved: aoResolver, expired: aoLimpar, error: aoLimpar },

        activate()   { _active = true;  },
        deactivate() { _active = false; },
        isResolved() {
            if (!_resolved || !_token) return false;
            return (Date.now() - _resolvedAt) < CAPTCHA_TOKEN_MAX_AGE_MS;
        },
        getToken() { return this.isResolved() ? _token : null; },
        reset() {
            _token = null; _resolved = false; _resolvedAt = 0;
            if (typeof turnstile === 'undefined') return;
            try {
                const widgetId = getWidgetId();
                if (widgetId !== null) turnstile.reset(widgetId);
                else turnstile.reset();
            } catch { /* widget ainda não renderizado */ }
        },
    };
}

/**
 * Guarda que recusa `render()` com callback que não seja função.
 * É a invariante que custou o bug de produção acima — vale repetir em cada
 * chamador, porque o erro real acontece dentro do api.js da Cloudflare, longe
 * daqui, e a mensagem de lá não ajuda ninguém.
 *
 * @returns {boolean} true se pode renderizar.
 */
export function callbacksValidos(callbacks, ondeEstou = 'turnstile') {
    for (const nome of ['resolved', 'expired', 'error']) {
        if (typeof callbacks?.[nome] !== 'function') {
            console.error(`[${ondeEstou}] callback "${nome}" não é função — render abortado.`);
            return false;
        }
    }
    return true;
}
