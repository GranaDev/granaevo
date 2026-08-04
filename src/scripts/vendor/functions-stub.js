// ----------------------------------------------------------------------------
// functions-stub.js — substitui @supabase/functions-js no bundle (Passo 8)
//
// POR QUE ISTO EXISTE
// O GranaEvo NUNCA chama `supabase.functions.invoke()`. Verificado em
// 2026-08-04: zero ocorrências de `.functions.` em todo o `src/`. As Edge
// Functions são chamadas pelos PROXIES em `api/` (server-side, com PROXY_SECRET)
// — nunca pelo cliente. É decisão de arquitetura, não acaso: invocar edge
// direto do browser exporia a URL da função e dependeria só do JWT.
//
// Mesmo assim o `functions-js` viajava no `vendor-supabase`, a maior peça do
// boot, porque o `supabase-js` o importa ESTATICAMENTE no topo do index.mjs:
//   import { FunctionRegion, FunctionsClient, ... } from "@supabase/functions-js"
// Import estático entra no bundle mesmo que nada o use em tempo de execução.
//
// ── POR QUE ESTE STUB É MAIS SEGURO QUE O DE REALTIME ──────────────────────
// O `FunctionsClient` é criado num GETTER PREGUIÇOSO (`get functions()`, linha
// 412 do index.mjs 2.104.1) — só nasce se alguém ler `client.functions`. O
// `RealtimeClient`, por contraste, é instanciado SEMPRE no construtor, e por
// isso aquele stub precisa implementar 5 métodos de verdade.
//
// Aqui nada é instanciado: enquanto ninguém tocar em `supabase.functions`, este
// arquivo é só uma forma que satisfaz o import. Se um dia alguém precisar
// invocar edge do cliente, o construtor lança na hora, com o motivo escrito —
// em vez de falhar em silêncio com um objeto que finge funcionar.
//
// ⚠️ MANUTENÇÃO: os 6 nomes abaixo são exatamente os que o `supabase-js`
// 2.104.1 importa. O supabase-js está PINADO no package.json justamente para
// que esta lista não mude sem alguém perceber. Ao subir de versão: conferir o
// `import ... from "@supabase/functions-js"` no topo do dist/index.mjs.
// ----------------------------------------------------------------------------

/** Erro-base: mantém a cadeia de instanceof de quem faça `catch (e)` genérico. */
export class FunctionsError extends Error {
    constructor(message, name = 'FunctionsError', context) {
        super(message);
        this.name = name;
        this.context = context;
    }
}

export class FunctionsFetchError extends FunctionsError {
    constructor(context) { super('Failed to send a request to the Edge Function', 'FunctionsFetchError', context); }
}
export class FunctionsRelayError extends FunctionsError {
    constructor(context) { super('Relay Error invoking the Edge Function', 'FunctionsRelayError', context); }
}
export class FunctionsHttpError extends FunctionsError {
    constructor(context) { super('Edge Function returned a non-2xx status code', 'FunctionsHttpError', context); }
}

/** Regiões — objeto de constantes, sem peso. */
export const FunctionRegion = {
    Any: 'any',
    ApNortheast1: 'ap-northeast-1', ApNortheast2: 'ap-northeast-2',
    ApSouth1: 'ap-south-1', ApSoutheast1: 'ap-southeast-1', ApSoutheast2: 'ap-southeast-2',
    CaCentral1: 'ca-central-1', EuCentral1: 'eu-central-1', EuWest1: 'eu-west-1',
    EuWest2: 'eu-west-2', EuWest3: 'eu-west-3', SaEast1: 'sa-east-1',
    UsEast1: 'us-east-1', UsWest1: 'us-west-1', UsWest2: 'us-west-2',
};

/**
 * Nunca é construído — o getter `functions` do SupabaseClient é preguiçoso e
 * nada no app o lê. Se alguém passar a ler, quebra AQUI, alto e claro.
 */
export class FunctionsClient {
    constructor() {
        throw new Error(
            'supabase.functions está desativado neste bundle (functions-stub.js). '
            + 'O GranaEvo chama Edge Functions pelos proxies em api/, server-side. '
            + 'Para invocar do cliente, remova o alias @supabase/functions-js do vite.config.js.',
        );
    }
}
