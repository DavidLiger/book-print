// scripts/fixtures/recherche-ed4.ts — mise en page et recherche de synthèse d'ED4 : une chaîne de trois paragraphes (le premier avec lettrine, les
// deux autres avec intertitre) sur deux cadres, une capsule à titre écrit, une question « Pourquoi… ? », une image avec sa légende et son
// étiquette (chacune avec sa consigne), un chiffre-clé ; et un fichier de recherche en version 2 qui la remplit. Le même générateur sert à
// `verif-ed4.mjs`, qui l'écrit au format du livre de David et avec les marges de son style. Le Fictivore n'existe pas : aucun contenu réel.
import { MM_PER_IN, type Margins, type Trim } from '../../src/templates/geometry';

const DEFAULT_MARGINS: Margins = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const SIX_NINE: Trim = { widthIn: 6, heightIn: 9 };

export interface SyntheseEd4Options {
  /** Longueur maximale de chaque paragraphe. */
  paragraphChars?: number;
  /** Le second paragraphe sans intertitre (pour l'écart des en-têtes, on le rajoute ensuite). */
  sansIntertitreP2?: boolean;
}

/** Page gauche (0) : titre, chapô, premier cadre en deux colonnes, capsule ; page droite (1) : second cadre, question, image, étiquette, chiffre-clé, légende. */
export function syntheseEd4(id = '2Q', trim: Trim = SIX_NINE, m: Margins = DEFAULT_MARGINS, options: SyntheseEd4Options = {}) {
  const w = trim.widthIn * MM_PER_IN;
  const pad = 2;
  const inner = w - m.outerMm - m.gutterMm - 2 * pad;
  const left = m.outerMm + pad;
  const right = m.gutterMm + pad;
  const top = m.topMm + pad;
  const chars = options.paragraphChars ?? 330;
  return {
    schemaVersion: 2,
    id,
    pages: 2,
    start: 'gauche',
    trim: { widthIn: trim.widthIn, heightIn: trim.heightIn },
    chaines: [
      {
        id: 'corps',
        cadres: ['texte-g', 'texte-d'],
        lettrine: true,
        paragraphes: [
          { id: 'p1', intertitre: false, maxChars: chars },
          options.sansIntertitreP2 ? { id: 'p2', intertitre: false, maxChars: chars } : { id: 'p2', intertitre: true, headingMaxChars: 28, maxChars: chars },
          { id: 'p3', intertitre: true, headingMaxChars: 28, maxChars: chars },
        ],
      },
    ],
    elements: [
      { id: 'titre', type: 'titre', page: 0, x: left, y: top, w: inner, h: 14, maxChars: 40 },
      { id: 'chapeau', type: 'chapeau', page: 0, x: left, y: top + 16, w: inner, h: 22, maxChars: 140 },
      { id: 'texte-g', type: 'texte', page: 0, x: left, y: top + 40, w: inner, h: 118, chaine: 'corps', colonnes: 2, gouttiereMm: 5 },
      { id: 'capsule', type: 'encadre', page: 0, x: left, y: top + 162, w: inner, h: 36, encadre: 'savais-tu', sorte: 'capsule', headingMaxChars: 24, maxChars: 140 },
      { id: 'texte-d', type: 'texte', page: 1, x: right, y: top, w: inner, h: 80, chaine: 'corps' },
      { id: 'question', type: 'encadre', page: 1, x: right, y: top + 84, w: inner, h: 44, encadre: 'a-cote-de-toi', sorte: 'question', headingMaxChars: 48, maxChars: 200 },
      { id: 'photo', type: 'illustration', page: 1, x: right, y: top + 132, w: 80, h: 50 },
      { id: 'etiquette', type: 'etiquette', page: 1, x: right + 2, y: top + 134, w: 36, h: 9, maxChars: 14, consigne: 'La queue de l’animal, en bas à gauche de l’image.' },
      { id: 'chiffre', type: 'chiffre-cle', page: 1, x: right + 84, y: top + 132, w: inner - 84, h: 50, maxChars: 30 },
      { id: 'legende', type: 'legende', page: 1, x: right, y: top + 184, w: inner, h: 14, maxChars: 90, image: 'photo', consigne: 'L’animal entier, de profil, dans les hautes herbes.' },
    ],
  };
}

const source = (n: number) => ({
  url: `https://source-${n}.example/page`,
  title: `Page de synthèse ${n}`,
  publisher: 'Éditeur fictif',
  accessed: '2026-11-11',
  support: 'Le passage dit la même chose, avec d\'autres mots.',
});

/** Mots numérotés, tous différents : un mot perdu ou répété par la coupure se voit. */
export const paragraphWords = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}mot${String(i + 1).padStart(2, '0')}`);

/** Fichier de recherche en version 2 qui remplit `syntheseEd4` : chaque paragraphe de 40 mots numérotés, chaque en-tête demandé. */
export function researchEd4(subjectId = 'alpha', lang: 'fr' | 'en' | 'es' = 'fr') {
  const para = (p: string) => paragraphWords(p, 40).join(' ');
  return {
    schemaVersion: 2 as const,
    subjectId,
    lang,
    generatedAt: '2026-11-11',
    claims: [
      { id: 'c1', text: 'Le Fictivore vit dans les pages de tests.', sources: [source(1)], confidence: 'forte' as const },
      { id: 'c2', text: 'Le Fictivore mesure deux mètres.', sources: [source(2)], confidence: 'forte' as const },
      { id: 'c3', text: 'Le Fictivore mange des baies.', sources: [source(3)], confidence: 'debattue' as const },
    ],
    blocks: [
      { zone: 'chapeau', type: 'chapeau' as const, text: 'Voici le Fictivore, un animal inventé qui vit dans les pages de tests.', claims: ['c1'] },
      { zone: 'corps', type: 'paragraphe' as const, paragraphe: 'p1', text: para('p1'), claims: ['c1'] },
      { zone: 'corps', type: 'paragraphe' as const, paragraphe: 'p2', heading: 'Un très grand animal', text: para('p2'), claims: ['c2'] },
      { zone: 'corps', type: 'paragraphe' as const, paragraphe: 'p3', heading: 'Que mange-t-il ?', text: para('p3'), claims: ['c3'] },
      { zone: 'capsule', type: 'encadre' as const, heading: 'Le sais-tu ?', text: 'Le Fictivore est aussi grand qu’une porte.', claims: ['c2'] },
      { zone: 'question', type: 'encadre' as const, heading: 'Pourquoi le Fictivore mange-t-il des baies ?', text: 'On pense qu’il aime leur goût sucré, mais personne n’en est sûr.', claims: ['c3'] },
      { zone: 'etiquette', type: 'etiquette' as const, text: 'Queue', claims: ['c1'] },
      { zone: 'chiffre', type: 'chiffre-cle' as const, text: '2 m de haut', claims: ['c2'] },
      { zone: 'legende', type: 'legende' as const, text: 'Le Fictivore dans les hautes herbes.', claims: ['c1'] },
    ],
  };
}
