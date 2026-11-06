// src/templates/2A.ts — gabarit 2A « Portrait » (spec §4.2). Toutes les distances partent de la zone de sécurité ou du bord
// rogné : la zone `texte`, tenue en haut et en bas, s'étire sur un autre format. Le numéro est centré dans sa zone, qui prend toute la largeur utile.
import type { Template } from './model';

const safe = (mm: number) => ({ from: 'securite', mm }) as const;
const trim = { from: 'rogne', mm: 0 } as const;

export const TEMPLATE_2A: Template = {
  id: '2A',
  pages: 2,
  start: 'gauche',
  sheets: [
    {
      zones: [
        // Le bandeau va au bord à gauche et en haut d'une page gauche : c'est le fond perdu de verso que PDF0 n'a pas mesuré.
        { id: 'bandeau', type: 'fond', bleed: true, box: { outer: trim, inner: trim, top: trim, heightMm: 37 } },
        { id: 'titre', type: 'titre', bleed: false, box: { outer: safe(0), inner: safe(0), top: safe(0), heightMm: 23 }, constraints: { maxChars: 40 } },
        { id: 'chapeau', type: 'chapeau', bleed: false, box: { outer: safe(0), inner: safe(0), top: safe(28), heightMm: 24 }, constraints: { maxChars: 140 } },
        { id: 'texte', type: 'texte', bleed: false, box: { outer: safe(0), inner: safe(0), top: safe(53), bottom: safe(58) }, constraints: { maxChars: 600 } },
        { id: 'fiche', type: 'fiche', bleed: false, box: { outer: safe(0), inner: safe(0), bottom: safe(9), heightMm: 46 }, constraints: { maxPictos: 6, itemMaxChars: 28 } },
        { id: 'folio-g', type: 'folio', bleed: false, box: { outer: safe(0), inner: safe(0), bottom: safe(0), heightMm: 7 } },
      ],
    },
    {
      zones: [
        { id: 'illustration', type: 'illustration', bleed: true, box: { outer: trim, inner: trim, top: trim, bottom: trim } },
        { id: 'folio-d', type: 'folio', bleed: false, box: { outer: safe(0), inner: safe(0), bottom: safe(0), heightMm: 7 } },
        // Cartouche blanc opaque posé sur l'illustration : le QR reste noir sur blanc (spec, réalisation de MP2).
        { id: 'qr', type: 'qr', bleed: false, box: { outer: safe(0), bottom: safe(0), widthMm: 37, heightMm: 42 }, constraints: { qrSideMm: 25, maxChars: 44 } },
      ],
    },
  ],
};
