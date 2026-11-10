// scripts/fixtures/mises-en-page.ts — mise en page de synthèse en version 2 (ED1) : un bandeau, une capsule avec icône posée sur une image, une
// question, une légende rattachée à l'image, une étiquette fléchée et une image à cheval sur la double page. Le même générateur sert à
// `verif-ed1.mjs`, qui l'écrit dans la collection de David, au format de son livre et avec les marges de son style. Aucun contenu réel.
import { MM_PER_IN, type Margins, type Trim } from '../../src/templates/geometry';

const DEFAULT_MARGINS: Margins = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const SIX_NINE: Trim = { widthIn: 6, heightIn: 9 };

export const W = SIX_NINE.widthIn * MM_PER_IN;
export const H = SIX_NINE.heightIn * MM_PER_IN;

/** Coordonnées en mm sur la page rognée : page gauche (0) puis page droite (1), chaque élément dans la zone de sécurité de sa page. */
export function synthese(id = '2Y', trim: Trim = SIX_NINE, m: Margins = DEFAULT_MARGINS) {
  const w = trim.widthIn * MM_PER_IN;
  const h = trim.heightIn * MM_PER_IN;
  const inner = w - m.outerMm - m.gutterMm;
  const image = 110;
  return {
    schemaVersion: 2,
    id,
    pages: 2,
    start: 'gauche',
    trim: { widthIn: trim.widthIn, heightIn: trim.heightIn },
    elements: [
      { id: 'panorama', type: 'illustration', page: 0, x: 0, y: 0, w: 2 * w, h: image, double: true, fondPerdu: ['haut', 'exterieur'] },
      { id: 'bandeau', type: 'bandeau', page: 0, x: 0, y: image, w, h: 30, fondPerdu: ['exterieur'], maxChars: 30, alignement: 'milieu' },
      { id: 'chapeau', type: 'chapeau', page: 0, x: m.outerMm, y: image + 36, w: inner, h: 22, maxChars: 110 },
      { id: 'texte', type: 'texte', page: 0, x: m.outerMm, y: image + 62, w: inner, h: 34, maxChars: 220 },
      { id: 'capsule', type: 'encadre', page: 0, x: m.outerMm + 2, y: m.topMm + 2, w: 62, h: 46, encadre: 'savais-tu', icone: 'taille', sorte: 'capsule', headingMaxChars: 18, maxChars: 90, alignement: 'milieu' },
      { id: 'folio-g', type: 'folio', page: 0, x: m.outerMm, y: h - m.bottomMm - 7, w: inner, h: 7 },
      { id: 'etiquette', type: 'etiquette', page: 1, x: w - m.outerMm - 50, y: m.topMm + 8, w: 50, h: 10, maxChars: 16, fleche: { x: m.gutterMm + 25, y: m.topMm + 58 }, consigne: 'La tête de l’animal.', alignement: 'milieu' },
      { id: 'legende', type: 'legende', page: 1, x: m.gutterMm, y: image + 6, w: inner, h: 14, maxChars: 80, image: 'panorama', consigne: 'Ce que montre la grande image.' },
      { id: 'question', type: 'encadre', page: 1, x: m.gutterMm, y: image + 24, w: inner, h: 34, encadre: 'savais-tu', sorte: 'question', headingMaxChars: 40, maxChars: 130, alignement: 'milieu' },
      { id: 'folio-d', type: 'folio', page: 1, x: m.gutterMm, y: h - m.bottomMm - 7, w: inner, h: 7 },
      { id: 'qr', type: 'qr', page: 1, x: w - m.outerMm - 37, y: h - m.bottomMm - 42, w: 37, h: 42, qrSideMm: 25, maxChars: 44 },
    ],
  };
}
