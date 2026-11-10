// scripts/fixtures/texte-detoure.ts — mise en page de synthèse d'ED2 : une chaîne sur deux cadres (le premier en deux colonnes), avec
// lettrine et intertitres, et un détouré qui habille la colonne du second cadre ; et un PNG de synthèse avec alpha (une forme et une partie
// détachée). Le même générateur sert à `verif-ed2.mjs`, qui l'écrit au format du livre de David et avec les marges de son style. Aucun contenu réel.
import { MM_PER_IN, type Margins, type Trim } from '../../src/templates/geometry';

const DEFAULT_MARGINS: Margins = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 15 };
const SIX_NINE: Trim = { widthIn: 6, heightIn: 9 };

export interface SyntheseOptions {
  /** Longueur de chaque paragraphe : assez court par défaut pour tenir, plus long pour un reste après la dernière boîte. */
  paragraphChars?: number;
  habillage?: 'gauche' | 'droite' | 'aucun';
  lettrine?: boolean;
}

/** Page gauche (0) : chapô, puis le premier cadre en deux colonnes ; page droite (1) : le second cadre, une colonne, et le détouré à droite. */
export function syntheseEd2(id = '2X', trim: Trim = SIX_NINE, m: Margins = DEFAULT_MARGINS, options: SyntheseOptions = {}) {
  const w = trim.widthIn * MM_PER_IN;
  const h = trim.heightIn * MM_PER_IN;
  // À 2 mm des bords de la zone de sécurité : C3 mesure la boîte des lignes, qui dépasse la ligne d'une police à grands jambages, et la boîte
  // d'une lettrine, décalée de l'approche de sa lettre.
  const pad = 2;
  const inner = w - m.outerMm - m.gutterMm - 2 * pad;
  const left = m.outerMm + pad;
  const right = m.gutterMm + pad;
  const chars = options.paragraphChars ?? 380;
  const top = m.topMm + pad + 30;
  const height = h - top - m.bottomMm - 10;
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
        lettrine: options.lettrine ?? true,
        paragraphes: [
          { id: 'p1', intertitre: false, maxChars: chars },
          { id: 'p2', intertitre: true, headingMaxChars: 24, maxChars: chars },
          { id: 'p3', intertitre: false, maxChars: chars },
          { id: 'p4', intertitre: true, headingMaxChars: 24, maxChars: chars },
          { id: 'p5', intertitre: false, maxChars: chars },
        ],
      },
    ],
    elements: [
      { id: 'chapeau', type: 'chapeau', page: 0, x: left, y: m.topMm + pad, w: inner, h: 24, maxChars: 100 },
      { id: 'texte-g', type: 'texte', page: 0, x: left, y: top, w: inner, h: height, chaine: 'corps', colonnes: 2, gouttiereMm: 5 },
      { id: 'texte-d', type: 'texte', page: 1, x: right, y: m.topMm + pad, w: inner, h: h - m.topMm - m.bottomMm - 2 * pad - 14, chaine: 'corps' },
      { id: 'animal', type: 'illustration', page: 1, x: right + inner - 70, y: m.topMm + 40, w: 80, h: 90, detoure: true, habillage: options.habillage ?? 'gauche' },
      // Une étiquette, en gras de la police des étiquettes : C7 veut chaque police du pack chargée (constat d'ED2).
      { id: 'etiquette', type: 'etiquette', page: 1, x: right + inner - 40, y: h - m.bottomMm - pad - 10, w: 40, h: 9, maxChars: 14 },
    ],
  };
}

/** PNG RVBA de synthèse : un corps ovale avec une tête, sur fond transparent, et une petite partie détachée (une « queue ») en bas à gauche. */
export async function detourePng(width = 800, height = 900): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const data = Buffer.alloc(width * height * 4);
  const set = (x: number, y: number, a: number) => {
    const i = (y * width + x) * 4;
    data[i] = 180;
    data[i + 1] = 90;
    data[i + 2] = 40;
    data[i + 3] = a;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const body = ((x - 0.5 * width) / (0.3 * width)) ** 2 + ((y - 0.55 * height) / (0.35 * height)) ** 2;
      const head = ((x - 0.62 * width) / (0.14 * width)) ** 2 + ((y - 0.17 * height) / (0.12 * height)) ** 2;
      const tail = ((x - 0.1 * width) / (0.05 * width)) ** 2 + ((y - 0.92 * height) / (0.04 * height)) ** 2;
      const d = Math.min(body, head, tail);
      // Un bord adouci sur un peu plus d'un pixel : l'alpha va de 255 à 0, comme un rendu réel.
      if (d <= 1) set(x, y, d > 0.99 ? 128 : 255);
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** PNG RVB sans alpha, et RVBA opaque partout : deux refus du dépôt d'un détouré. */
export async function opaquePngs(width = 40, height = 30): Promise<{ rgb: Buffer; rgbaOpaque: Buffer; rgbaTransparent: Buffer }> {
  const { default: sharp } = await import('sharp');
  const rgb = await sharp({ create: { width, height, channels: 3, background: '#808080' } }).png().toBuffer();
  const rgbaOpaque = await sharp({ create: { width, height, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } }).png().toBuffer();
  const rgbaTransparent = await sharp({ create: { width, height, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 0 } } }).png().toBuffer();
  return { rgb, rgbaOpaque, rgbaTransparent };
}
