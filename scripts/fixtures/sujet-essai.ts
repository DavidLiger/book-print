// scripts/fixtures/sujet-essai.ts — sujet d'essai du gabarit 2A, pour les tests. Les contenus factices vivent dans src/render/placeholders.ts.
import type { RenderContent } from '../../src/render/html';
import { fakeQr, placeholderImage, PLACEHOLDER_FICHE, PLACEHOLDER_FICHE_VALUES, PLACEHOLDER_LEGEND, PLACEHOLDER_PHRASES, PLACEHOLDER_TEXTS } from '../../src/render/placeholders';
import { subjectSchema } from '../../src/schema/subject';
import type { Trim } from '../../src/templates/geometry';

export const ESSAI_TEMPLATE = '2A';
/** Les sujets commencent en p. 6 dans le plan du §5.1 : page paire, donc page gauche. */
export const ESSAI_FIRST_PAGE = 6;

/** Sujet valide au schéma, à 2 pages. */
export const essaiSubject = (theme: string) =>
  subjectSchema.parse({ schemaVersion: 1, id: 'sujet-essai', title: { fr: 'Essaisaurus factice' }, pages: 2, template: ESSAI_TEMPLATE, variant: { mirror: false, theme }, blocks: [], illustrations: [], status: 'brouillon' });

export { fakeQr };
export const essaiImage = placeholderImage;
export const ESSAI_PHRASES = PLACEHOLDER_PHRASES;
export const ESSAI_FICHE_VALUES = PLACEHOLDER_FICHE_VALUES;

export function essaiContent(theme: string, trim: Trim, lang: RenderContent['lang'] = 'fr'): RenderContent {
  return { title: 'Essai', lang, theme, texts: PLACEHOLDER_TEXTS, fiche: PLACEHOLDER_FICHE, ficheMissing: 'valeur d\'essai', images: { illustration: placeholderImage(trim) }, qrSvg: fakeQr(), qrLegend: PLACEHOLDER_LEGEND };
}
