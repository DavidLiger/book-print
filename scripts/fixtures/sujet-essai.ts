// scripts/fixtures/sujet-essai.ts — sujet d'essai du gabarit 2A. Tout est synthétique et clairement factice : aucun texte du
// livre, aucune illustration, aucun QR réel. Le faux QR n'encode rien : le vrai QR et C9 arrivent en MP5.
import type { RenderContent } from '../../src/render/html';
import { subjectSchema } from '../../src/schema/subject';
import { pageSize, type Trim } from '../../src/templates/geometry';
import { makePng, pngDataUri } from './make-png';

export const ESSAI_TEMPLATE = '2A';
/** Les sujets commencent en p. 6 dans le plan du §5.1 : page paire, donc page gauche. */
export const ESSAI_FIRST_PAGE = 6;

/** Sujet valide au schéma, à 2 pages. */
export const essaiSubject = (theme: string) =>
  subjectSchema.parse({ schemaVersion: 1, id: 'sujet-essai', title: { fr: 'Essaisaurus factice' }, pages: 2, template: ESSAI_TEMPLATE, variant: { mirror: false, theme }, blocks: [], illustrations: [], status: 'brouillon' });

const TEXTS = {
  titre: 'Essaisaurus factice',
  chapeau: 'Ce texte d\'essai ne décrit aucun animal réel. Il sert seulement à voir la place que prend un chapeau.',
  texte:
    'Ceci est un texte factice, écrit pour régler la mise en page. L\'Essaisaurus n\'a jamais existé : ni ses dents en carton, ni sa queue en forme de règle, ni son goût pour les marges bien droites. ' +
    'On lit ici la taille des lettres, la longueur des lignes et l\'espace entre elles. Un enfant de huit ans doit pouvoir suivre chaque ligne sans se perdre. ' +
    'Le vrai texte arrivera plus tard, relu et sourcé, affirmation par affirmation. Rien de ce paragraphe ne doit se retrouver dans un livre, pas même sa dernière phrase, qui remplit la zone.',
};

const FICHE: Record<string, string> = { taille: '12 règles', poids: '3 cartons', epoque: 'L\'an dernier', regime: 'Mange des marges', lieu: 'Dossier d\'essai' };

/** Faux QR : mêmes proportions qu'un vrai, sans rien d'encodé. */
export function fakeQr(): string {
  const n = 29;
  const cells: string[] = [];
  const finder = (x: number, y: number) => x >= 0 && y >= 0 && x < 7 && y < 7 && (x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const on = finder(x, y) || finder(x - (n - 7), y) || finder(x, y - (n - 7)) || (!inFinder(x, y) && (x * 7 + y * 13 + x * y) % 3 === 0);
      if (on) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h${n + 8}v${n + 8}H0z"/><path fill="#000000" d="${cells.join('')}"/></svg>`;
}

const cache = new Map<string, string>();

/** Paysage de synthèse à 300 ppp pleine page, sans alpha : ciel, soleil et deux collines. */
export function essaiImage(trim: Trim): string {
  const size = pageSize(trim);
  const w = Math.ceil(size.widthIn * 300);
  const h = Math.ceil(size.heightIn * 300);
  const key = `${w}x${h}`;
  let uri = cache.get(key);
  if (!uri) {
    const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    const sun = { x: w * 0.68, y: h * 0.22, r: w * 0.11 };
    uri = pngDataUri(
      makePng(w, h, 3, (x, y) => {
        const hill1 = h * (0.62 + 0.05 * Math.sin((x / w) * 5));
        const hill2 = h * (0.74 + 0.04 * Math.sin((x / w) * 9 + 1));
        if (y > hill2) return [mix(58, 34, (y - hill2) / (h - hill2)), mix(120, 84, (y - hill2) / (h - hill2)), 62];
        if (y > hill1) return [96, 148, 92];
        if ((x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2) return [250, 214, 110];
        const t = y / hill1;
        return [mix(120, 244, t), mix(176, 222, t), mix(222, 190, t)];
      }),
    );
    cache.set(key, uri);
  }
  return uri;
}

const LEGEND = 'QR factice : ne pas scanner, c\'est un essai';

export function essaiContent(theme: string, trim: Trim, lang: RenderContent['lang'] = 'fr'): RenderContent {
  return { title: 'Essai', lang, theme, texts: TEXTS, fiche: FICHE, ficheMissing: 'valeur d\'essai', images: { illustration: essaiImage(trim) }, qrSvg: fakeQr(), qrLegend: LEGEND };
}

/** Pour C13 : aucune de ces phrases ne doit se retrouver dans un vrai sujet. */
export const ESSAI_PHRASES = [TEXTS.titre, ...[TEXTS.chapeau, TEXTS.texte].flatMap((t) => t.split(/(?<=[.:])\s+/)), LEGEND];
export const ESSAI_FICHE_VALUES = Object.values(FICHE);
