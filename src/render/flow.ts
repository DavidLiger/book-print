// src/render/flow.ts — texte qui coule (ED2, spec §24.5). Une chaîne est une suite de jetons : pour chaque paragraphe, son intertitre (s'il
// en a un), puis ses mots. Chaque boîte de la chaîne (une colonne d'un cadre, dans l'ordre des cadres puis de gauche à droite) reçoit une
// tranche de jetons. Première passe, dans la page Chromium des mesures : chaque boîte est remplie avec ce qui reste de la chaîne, et la coupure
// au mot est trouvée par dichotomie sur le nombre de jetons ; un intertitre n'est jamais le dernier jeton d'une boîte. Seconde passe : le HTML
// final, déjà coupé, écrit par `render/html.ts` avec ces coupures. Le même HTML sert à l'aperçu et au PDF.
//
// Le balisage d'une tranche (`FLOW_LIB`) est un seul texte JavaScript, exécuté dans Chromium pour la mesure et dans Node pour le HTML final :
// ce qui est mesuré est exactement ce qui est écrit. Une fonction passée à `page.evaluate` casserait sous tsx (comme `measure.ts`).

export interface ChainParagraph {
  id: string;
  /** Intertitre du paragraphe ; `null` sans intertitre. */
  heading: string | null;
  text: string;
}
export interface ChainText {
  /** Cadres de la chaîne, dans l'ordre de lecture. */
  cadres: string[];
  lettrine: boolean;
  paragraphs: ChainParagraph[];
}
/** Fin (exclue) de la tranche de jetons de chaque boîte, dans l'ordre des boîtes ; et les mots restés après la dernière boîte (C12). */
export interface ChainCut {
  ends: number[];
  rest: number;
  words: number;
}

export const FLOW_LIB = `
function flowEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Les mots sont séparés par les seules espaces ordinaires : une espace insécable (« mot », 12 kg) garde ses deux voisins ensemble.
function flowTokens(chain) {
  const out = [];
  chain.paragraphs.forEach((p, i) => {
    if (p.heading !== null) out.push({ k: 'h', p: i });
    String(p.text).split(/[ \\t\\r\\n]+/).filter(Boolean).forEach((w, j) => out.push({ k: 'w', p: i, t: w, first: j === 0 }));
  });
  return out;
}
// Tranche [start, end) : un intertitre en tête de boîte n'a pas d'espace au-dessus ; seul un paragraphe qui commence ici, après le premier,
// sans intertitre, a son retrait ; la lettrine est sur le premier mot de la chaîne.
function flowBox(chain, tokens, start, end) {
  let html = '';
  let words = [];
  let para = -1;
  let opening = false;
  const close = () => {
    if (words.length === 0) return;
    const p = chain.paragraphs[para];
    const cls = [];
    if (opening && para === 0 && chain.lettrine) cls.push('lettrine');
    else if (opening && para > 0 && p.heading === null) cls.push('retrait');
    html += '<p' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + ' data-para="' + flowEsc(p.id) + '">' + words.map(flowEsc).join(' ') + '</p>';
    words = [];
  };
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.p !== para) {
      close();
      para = t.p;
      opening = false;
    }
    if (t.k === 'h') {
      html += '<h3 class="intertitre' + (html === '' ? ' tete' : '') + '" data-para="' + flowEsc(chain.paragraphs[t.p].id) + '">' + flowEsc(chain.paragraphs[t.p].heading) + '</h3>';
    } else {
      if (words.length === 0) opening = t.first;
      words.push(t.t);
    }
  }
  close();
  return html;
}`;

const lib = new Function(`${FLOW_LIB}\nreturn { flowTokens, flowBox };`)() as {
  flowTokens: (chain: ChainText) => { k: 'h' | 'w'; p: number; t?: string; first?: boolean }[];
  flowBox: (chain: ChainText, tokens: unknown[], start: number, end: number) => string;
};

export const chainTokens = (chain: ChainText) => lib.flowTokens(chain);
export const chainWords = (chain: ChainText) => chainTokens(chain).filter((t) => t.k === 'w').length;

/** Le HTML d'une tranche de la chaîne, celui que la première passe a mesuré. */
export function boxMarkup(chain: ChainText, start: number, end: number): string {
  return lib.flowBox(chain, lib.flowTokens(chain), start, end);
}

/**
 * Première passe : le script lancé dans la page qui porte le HTML sans texte des chaînes (boîtes vides, flottants d'habillage en place).
 * Il remplit les boîtes une à une, comme le fera le HTML final, et rend les coupures.
 */
export function flowScript(chains: Record<string, ChainText>): string {
  return `(() => {
${FLOW_LIB}
const chains = ${JSON.stringify(chains).replace(/</g, '\\u003c')};
const out = {};
for (const id of Object.keys(chains)) {
  const chain = chains[id];
  const tokens = flowTokens(chain);
  const boxes = Array.from(document.querySelectorAll('[data-chaine]')).filter((b) => b.dataset.chaine === id).sort((a, b) => Number(a.dataset.boite) - Number(b.dataset.boite));
  const ends = [];
  let start = 0;
  for (const box of boxes) {
    const fill = box.querySelector('.flux');
    const floats = fill.innerHTML;
    const bottom = box.getBoundingClientRect().bottom;
    // Une demi-unité de pixel de tolérance, comme la mesure du débordement (C12).
    const fits = (end) => { fill.innerHTML = floats + flowBox(chain, tokens, start, end); return fill.getBoundingClientRect().bottom <= bottom + 0.5; };
    let lo = start;
    let hi = tokens.length;
    if (fits(hi)) lo = hi;
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    let end = lo;
    // Un intertitre n'est jamais la dernière ligne d'une boîte : il passe dans la suivante avec la première ligne de son texte.
    if (end > start && tokens[end - 1].k === 'h') end--;
    fill.innerHTML = floats + flowBox(chain, tokens, start, end);
    ends.push(end);
    start = end;
  }
  out[id] = { ends, rest: tokens.slice(start).filter((t) => t.k === 'w').length, words: tokens.filter((t) => t.k === 'w').length };
}
return out;
})()`;
}
