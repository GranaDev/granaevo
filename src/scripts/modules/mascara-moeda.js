/**
 * mascara-moeda.js — máscara monetária BRL para TODO campo de digitar valor.
 *
 * POR QUE ESTE MÓDULO EXISTE (2026-08-07):
 * Só o campo de valor do formulário principal tinha máscara (o usuário digitava
 * 100 e virava "100,00"); todos os outros campos de dinheiro do app — conta fixa,
 * limite do cartão, compra da fatura, orçamento, reservas, retirada — eram
 * `type="number"` cru. O comportamento mudava de tela para tela.
 *
 * COMO FUNCIONA
 * O campo passa a ser `type="text"` e só aceita DÍGITOS: os dois últimos são os
 * centavos. Digitar 1, 0, 0 mostra "1,00" e depois "10,00" e depois "100,00".
 * Não existe estado inválido possível — não dá para digitar duas vírgulas, letra
 * ou ponto solto.
 *
 * ARMADILHA (a razão de `lerMoeda` existir):
 * com máscara, `input.value` é "1.234,56". `parseFloat("1.234,56")` devolve
 * **1.234** — lê mil reais como um e vinte e três. TODO ponto que lia o valor
 * desses campos com parseFloat foi trocado por `lerMoeda(el)`. Quem for mascarar
 * um campo novo tem de trocar a leitura dele junto, no mesmo commit.
 *
 * `lerMoeda` devolve NaN para campo vazio — de propósito, é o que
 * `parseFloat('')` devolvia. As validações existentes (`isNaN`, `<= 0`,
 * `Number.isFinite`) continuam valendo sem precisar de mudança.
 */

/** 11 dígitos = 999.999.999,99. Teto de digitação; os limites de negócio de cada
 *  campo continuam sendo validados por quem chama (com a mensagem de erro dele). */
const MAX_DIGITOS = 11;

/** Só os dígitos, sem zeros à esquerda e limitados ao teto. */
function _digitos(txt, max) {
    return String(txt ?? '')
        .replace(/\D/g, '')
        .replace(/^0+(?=\d)/, '')
        .slice(0, max);
}

/**
 * "100" → "1,00" · "R$ 1234,5" → "12.345,00" (só dígitos contam) · "" → "".
 * @param {string} txt
 * @param {number} [max] teto de dígitos
 * @returns {string}
 */
export function formatarMoeda(txt, max = MAX_DIGITOS) {
    const d = _digitos(txt, max);
    if (!d) return '';
    return (Number(d) / 100).toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

/**
 * Número por trás de um texto JÁ MASCARADO. Campo vazio → NaN (igual ao
 * parseFloat('') de antes). Não use em texto livre: aqui "1.234,5" é 12.345,00,
 * porque só os dígitos contam.
 * @param {string} txt
 * @returns {number}
 */
export function valorDeMoeda(txt) {
    const d = _digitos(txt, MAX_DIGITOS);
    if (!d) return NaN;
    return Number(d) / 100;
}

/**
 * Lê o valor de um campo. Se ele tem máscara, decodifica; se não tem (ainda),
 * cai no parseFloat de sempre — assim a função é segura em qualquer campo.
 * @param {HTMLInputElement|string|null} alvo elemento ou id
 * @returns {number} valor em reais, ou NaN se vazio/inválido
 */
export function lerMoeda(alvo) {
    const el = typeof alvo === 'string' ? document.getElementById(alvo) : alvo;
    if (!el) return NaN;
    if (el.dataset && el.dataset.moeda === '1') return valorDeMoeda(el.value);
    return parseFloat(el.value);
}

/**
 * Preenche o campo com um número já formatado ("1.234,56"). Vazio/NaN limpa o
 * campo; zero vira "0,00" (é um valor legítimo em ajuste de reserva).
 * @param {HTMLInputElement|string|null} alvo
 * @param {number|string|null} valor
 */
export function definirMoeda(alvo, valor) {
    const el = typeof alvo === 'string' ? document.getElementById(alvo) : alvo;
    if (!el) return;
    const n = Number(valor);
    if (valor === '' || valor == null || !Number.isFinite(n)) { el.value = ''; return; }
    const max = Number(el.dataset?.moedaMax) || MAX_DIGITOS;
    el.value = formatarMoeda(String(Math.round(Math.abs(n) * 100)), max);
}

function _aoDigitar(e) {
    const el = e.target;
    const antes = el.value;
    const depois = formatarMoeda(antes, Number(el.dataset.moedaMax) || MAX_DIGITOS);
    if (depois === antes) return;   // nada mudou: não mexe no cursor

    el.value = depois;

    // CURSOR SEMPRE NO FIM — e isto NÃO é preguiça, é o único lugar correto.
    // A máscara é da direita para a esquerda: o dígito novo é sempre o centavo
    // menos significativo e TODO o resto anda uma casa para a esquerda. Além
    // disso o texto ganha um zero sintético que ninguém digitou ("1" → "0,01"),
    // então contar dígitos a partir da esquerda para reposicionar o cursor
    // devolve uma posição no meio do número — e aí o dígito seguinte entra no
    // lugar errado. Foi exatamente esse o bug: digitar 1,0,0 travava em "0,01".
    const fim = depois.length;
    try { el.setSelectionRange(fim, fim); } catch (_) { /* campo sem seleção */ }
}

/**
 * Liga a máscara num campo. Idempotente — chamar duas vezes não duplica listener.
 * Converte `type="number"` em `type="text"` (number recusa "1.234,56") mantendo o
 * teclado numérico no celular via inputmode.
 *
 * @param {HTMLInputElement|string|null} alvo elemento ou id
 * @param {{maxDigitos?:number, selecionarAoFocar?:boolean}} [opts]
 * @returns {HTMLInputElement|null} o próprio campo, para encadear
 */
export function aplicarMascaraMoeda(alvo, opts = {}) {
    const el = typeof alvo === 'string' ? document.getElementById(alvo) : alvo;
    if (!el) return null;
    if (el.dataset.moeda === '1') return el;

    const max = Number.isInteger(opts.maxDigitos) ? opts.maxDigitos : MAX_DIGITOS;
    const valorInicial = el.value;

    el.type = 'text';
    el.inputMode = 'decimal';
    el.autocomplete = 'off';
    el.removeAttribute('step');
    el.removeAttribute('maxlength');   // o teto passa a ser em dígitos, não em caracteres
    el.dataset.moeda = '1';
    el.dataset.moedaMax = String(max);

    el.addEventListener('input', _aoDigitar);
    el.addEventListener('blur', _aoDigitar);
    if (opts.selecionarAoFocar !== false) {
        el.addEventListener('focus', () => {
            requestAnimationFrame(() => { try { el.select(); } catch (_) { /* ignora */ } });
        });
    }

    // Valor que já estava no campo (formulário de edição montado antes da máscara).
    if (valorInicial !== '') definirMoeda(el, valorInicial);
    return el;
}
