// merge-profiles.ts — o merge por perfil que impede casal/família de se
// sobrescreverem.
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE
// Casal e família compartilham UMA linha em `user_data` (a do dono). Cada save
// reescrevia o ARRAY INTEIRO de perfis, então:
//
//   ela carrega [A,B] · ele carrega [A,B]
//   ela edita B → grava [A(velho), B(novo)]
//   ele edita A → grava [A(novo), B(VELHO)]   ← o trabalho dela morre
//
// Eles nem mexeram no mesmo perfil: o conflito era do FORMATO, não do conteúdo.
// E sumia sem erro, sem aviso, sem log — o dono descobriu usando o app.
//
// A REGRA: o cliente declara quais perfis tocou. Para esses, o que chegou vale.
// Para os demais, mantém-se o gravado. Ninguém afirma nada sobre perfil que não
// editou.
//
// Não usa relógio de propósito: celular e desktop dessincronizam, e "quem
// salvou por último" é a pergunta errada — a certa é "sobre o que este cliente
// tem autoridade para falar".
//
// MORA NUM ARQUIVO PRÓPRIO porque decide o destino de todo o dado financeiro do
// app: precisa de teste que exercite o comportamento, não asserção sobre texto.
// ---------------------------------------------------------------------------

export interface MergeResult {
  /** Lista final a gravar. */
  profiles: any[];
  /** Quantos perfis vieram do disco por não terem sido declarados. */
  preservados: number;
  /** Ids declarados e ausentes no payload = exclusão pedida. */
  removidos: string[];
}

/**
 * @param guardados  Perfis atualmente no banco (já decifrados).
 * @param chegando   Perfis enviados por este cliente.
 * @param tocados    Ids que este cliente declara ter editado.
 */
export function mergeProfiles(
  guardados: any[],
  chegando: any[],
  tocados: Iterable<string>,
): MergeResult {
  const declarados = new Set(Array.from(tocados, (x) => String(x)));
  const porId      = new Map(chegando.map((p) => [String(p?.id), p]));
  const out: any[] = [];
  const removidos: string[] = [];
  let preservados = 0;

  // Mantém a ORDEM do disco: a lista de perfis aparece na UI, e reordenar a
  // cada save de outro membro seria desconcertante.
  for (const g of guardados) {
    const id = String(g?.id);
    if (!declarados.has(id)) { out.push(g); preservados++; continue; }
    const novo = porId.get(id);
    if (novo) out.push(novo);
    else removidos.push(id);   // declarou e não mandou = exclusão explícita
  }

  // Perfil NOVO só entra se declarado. Sem isso, um cliente com cópia velha
  // "ressuscitaria" um perfil que outro membro acabou de apagar.
  const idsGuardados = new Set(guardados.map((g) => String(g?.id)));
  for (const [id, novo] of porId) {
    if (declarados.has(id) && !idsGuardados.has(id)) out.push(novo);
  }

  return { profiles: out, preservados, removidos };
}
