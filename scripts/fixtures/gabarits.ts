// scripts/fixtures/gabarits.ts — le gabarit 2A livré (GB1), lu dans `src/templates/defaults/gabarits/2A.json` et validé par le schéma.
import { deliveredTemplate } from '../../src/templates/files';

export const TEMPLATE_2A = deliveredTemplate('2A');

const safe = (mm: number) => ({ from: 'securite', mm }) as const;
const trim = { from: 'rogne', mm: 0 } as const;

/**
 * Gabarit synthétique aux cinq types rendus depuis GB1 : encadré, chiffre-clé, légende, pictogramme, étiquette. Le même JSON est écrit par
 * `verif-gb1.mjs` dans la collection de David pour son jugement. Les longueurs tiennent au texte de remplissage.
 */
export const fiveTypes = (id = '2Z') => ({
  id,
  pages: 2,
  start: 'gauche',
  sheets: [
    {
      zones: [
        { id: 'bandeau', type: 'fond', bleed: true, box: { outer: trim, inner: trim, top: trim, heightMm: 37 } },
        { id: 'titre', type: 'titre', bleed: false, box: { outer: safe(0), inner: safe(0), top: safe(0), heightMm: 23 }, constraints: { maxChars: 24 } },
        { id: 'chiffre', type: 'chiffre-cle', bleed: false, sizePt: 40, box: { outer: safe(0), widthMm: 70, top: safe(28), heightMm: 24 }, constraints: { maxChars: 8 } },
        { id: 'picto', type: 'picto', bleed: false, picto: 'taille', box: { inner: safe(0), widthMm: 24, top: safe(28), heightMm: 24 } },
        {
          id: 'savais-tu',
          type: 'encadre',
          bleed: false,
          encadre: 'savais-tu',
          heading: { fr: 'Le savais-tu ?', en: 'Did you know?', es: '¿Sabías que…?' },
          box: { outer: safe(0), inner: safe(0), top: safe(57), heightMm: 70 },
          constraints: { maxChars: 220 },
        },
        { id: 'folio-g', type: 'folio', bleed: false, box: { outer: safe(0), inner: safe(0), bottom: safe(0), heightMm: 7 } },
      ],
    },
    {
      zones: [
        { id: 'illustration', type: 'illustration', bleed: true, box: { outer: trim, inner: trim, top: trim, heightMm: 150 } },
        { id: 'etiquette', type: 'etiquette', bleed: false, box: { outer: safe(0), widthMm: 60, top: safe(6), heightMm: 11 }, constraints: { maxChars: 20 } },
        { id: 'legende', type: 'legende', bleed: false, box: { outer: safe(0), inner: safe(0), top: safe(142), heightMm: 14 }, constraints: { maxChars: 90 } },
        { id: 'folio-d', type: 'folio', bleed: false, box: { outer: safe(0), inner: safe(0), bottom: safe(0), heightMm: 7 } },
        { id: 'qr', type: 'qr', bleed: false, box: { outer: safe(0), bottom: safe(0), widthMm: 37, heightMm: 42 }, constraints: { qrSideMm: 25, maxChars: 44 } },
      ],
    },
  ],
});
