// ----------------------------------------------------------------------------
// realtime-stub.js — substitui @supabase/realtime-js no bundle (Passo 8)
//
// POR QUE ISTO EXISTE:
// O GranaEvo NÃO usa Supabase Realtime. Verificado em 2026-07-17: zero
// `.channel(`, zero `.subscribe(` de canal Supabase no código (a única
// "subscribe" é `pushManager.subscribe` do Web Push, outra coisa). A publicação
// de Realtime no banco está VAZIA (auditoria RLS). Mesmo assim, o construtor do
// SupabaseClient faz `new RealtimeClient()` SEMPRE — então o tree-shake não
// remove, e o realtime-js real (~18,9 KB gzip transitivo) viajava no
// `vendor-supabase`, a MAIOR peça do bundle de boot.
//
// Este stub é aliasado para `@supabase/realtime-js` no vite.config.js. Medido:
// vendor-supabase 48,6 → 34,2 KB gzip (−14,4 KB no boot, −30% do chunk).
//
// ── O QUE O STUB PRECISA COBRIR (não mais, não menos) ───────────────────────
// O SupabaseClient 2.104.1 acessa EXATAMENTE 5 métodos de `this.realtime`
// (verificado por grep no dist/index.mjs):
//   channel · getChannels · removeChannel · removeAllChannels · setAuth
// `setAuth` é o crítico: é chamado em TODA troca de token (onAuthStateChange).
// Se faltasse, o LOGIN quebraria. Por isso os 5 são no-op reais, não throw.
//
// connect/disconnect/onOpen/onClose entram por margem: versões próximas do
// supabase-js os chamam em alguns caminhos. Todos no-op — nunca disparam de
// verdade porque o app não abre canal.
//
// ⚠️ ACOPLADO À VERSÃO: por isso `@supabase/supabase-js` está PINADO em 2.104.1
// no package.json. Ao subir a versão, reconferir a lista de métodos acima com:
//   grep -oE "this\.realtime\.[a-zA-Z_]+" node_modules/@supabase/supabase-js/dist/index.mjs
// ----------------------------------------------------------------------------

const _noopChannel = {
  on()          { return this; },
  subscribe()   { return this; },
  unsubscribe() { return Promise.resolve('ok'); },
  send()        { return Promise.resolve('ok'); },
  track()       { return Promise.resolve('ok'); },
  untrack()     { return Promise.resolve('ok'); },
  presenceState() { return {}; },
};

export class RealtimeClient {
  constructor(_endpoint, _options) {
    this.channels = [];
    this.accessToken = null;
  }

  // Os 5 que o SupabaseClient 2.104.1 realmente chama:
  channel()           { return _noopChannel; }
  getChannels()       { return this.channels; }
  removeChannel()     { return Promise.resolve('ok'); }
  removeAllChannels() { return Promise.resolve(['ok']); }
  setAuth(token)      { this.accessToken = token ?? null; }   // crítico: login usa

  // Margem para outras versões — nunca disparam (app não abre canal):
  connect()    { return this; }
  disconnect() {}
  onOpen()     {}
  onClose()    {}
  onError()    {}
}

// realtime-js exporta named + algumas ferramentas; o SupabaseClient só importa
// `RealtimeClient`. Reexporta como default também por segurança de resolução.
export default RealtimeClient;
