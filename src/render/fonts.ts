// src/render/fonts.ts — pack de polices (paquets npm OFL), embarquées en `data:` dans le HTML : même approche que
// `scripts/docs/build-guide.ts` de GLBInterpreter. Le PDF est le même sur toute machine, sans police système.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONT_PACKS } from '../schema/style';

const MODULES = fileURLToPath(new URL('../../node_modules/', import.meta.url));

export interface PackFont {
  family: string;
  /** Début du nom de la police dans le PDF, en minuscules, sans séparateur (C7). */
  pdfName: string;
  faces: { weight: string; file: string }[];
}

export const FONT_PACK: Record<(typeof FONT_PACKS)[number], PackFont> = {
  andika: {
    family: 'Andika',
    pdfName: 'andika',
    faces: [
      { weight: '400', file: '@fontsource/andika/files/andika-latin-400-normal.woff2' },
      { weight: '700', file: '@fontsource/andika/files/andika-latin-700-normal.woff2' },
    ],
  },
  'baloo-2': {
    family: 'Baloo 2',
    pdfName: 'baloo2',
    faces: [{ weight: '400 800', file: '@fontsource-variable/baloo-2/files/baloo-2-latin-wght-normal.woff2' }],
  },
};

const cache = new Map<string, string>();

function dataUri(file: string): string {
  let uri = cache.get(file);
  if (!uri) {
    uri = `data:font/woff2;base64,${fs.readFileSync(`${MODULES}${file}`).toString('base64')}`;
    cache.set(file, uri);
  }
  return uri;
}

/** Règles `@font-face` du pack, fichiers embarqués : le HTML ne dépend d'aucun fichier ni d'aucun réseau. */
export function fontFaces(): string {
  return Object.values(FONT_PACK)
    .flatMap((font) => font.faces.map((face) => `@font-face { font-family: '${font.family}'; font-weight: ${face.weight}; font-style: normal; src: url(${dataUri(face.file)}) format('woff2'); }`))
    .join('\n');
}
