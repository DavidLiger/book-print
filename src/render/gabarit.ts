// src/render/gabarit.ts — aperçu d'un gabarit de la collection (GB1, étape Gabarits). Contenu synthétique, à la longueur maximale de chaque zone :
// ce qui tient là tiendra avec un vrai texte. Même HTML que le PDF. Le contrôle rend le PDF en mémoire, sans rien écrire, et n'est pas conservé.
import { essaiImage, fakeQr } from '../../scripts/fixtures/sujet-essai';
import { readPdfFacts } from '../checks/pdf-facts';
import { runChecks, type CheckResult } from '../checks/rules';
import { readCollection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { readTemplates, templateOf } from '../templates/files';
import { layoutTemplate, type LayoutPage, type Trim } from '../templates/geometry';
import type { Template } from '../templates/model';
import { FONT_PACK } from './fonts';
import { applyBookFiche, renderHtml, RenderRefused, type RenderContent } from './html';
import { renderPdf } from './pdf';

/** Texte de remplissage, clairement synthétique, à exactement `n` caractères. */
const FILLER = 'Texte de remplissage du gabarit, sans contenu réel. ';
export function fillerText(n: number): string {
  let out = '';
  while (out.length < n) out += FILLER;
  out = out.slice(0, n);
  // Une fin sur une espace compterait un caractère invisible : un point le remplace.
  return out.endsWith(' ') ? `${out.slice(0, -1)}.` : out;
}

const zonesOf = (template: Template) => template.sheets.flatMap((s) => s.zones);

/** Textes de remplissage de toutes les zones à texte, à leur longueur maximale. */
export function fillerTexts(template: Template): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zone of zonesOf(template)) {
    const max = zone.constraints?.maxChars;
    if (zone.type !== 'qr' && zone.type !== 'fiche' && max !== undefined) out[zone.id] = fillerText(max);
  }
  return out;
}

/** L'image d'essai dans chaque zone d'illustration. */
export function fillerImages(template: Template, trim: Trim): Record<string, string> {
  return Object.fromEntries(zonesOf(template).filter((z) => z.type === 'illustration').map((z) => [z.id, essaiImage(trim)]));
}

/** Contenu de l'aperçu d'un gabarit : remplissage partout, valeurs de fiche et légende du QR à leur longueur maximale. */
export function templateContent(template: Template, fiche: { id: string }[], theme: string, trim: Trim): RenderContent {
  const fiches = zonesOf(template).filter((z) => z.type === 'fiche');
  const itemMax = Math.max(1, ...fiches.map((z) => z.constraints?.itemMaxChars ?? 1));
  const qr = zonesOf(template).find((z) => z.type === 'qr');
  return {
    title: 'Gabarit',
    lang: 'fr',
    theme,
    texts: fillerTexts(template),
    fiche: Object.fromEntries(fiche.map((item) => [item.id, fillerText(itemMax)])),
    ficheMissing: '',
    images: fillerImages(template, trim),
    qrSvg: fakeQr(),
    qrLegend: fillerText(qr?.constraints?.maxChars ?? 20),
  };
}

export interface TemplatePreview {
  html: string;
  layout: LayoutPage[];
  trim: Trim;
  template: Template;
}

/** Le format vient du livre, le style de la collection. Un gabarit `droite` commence en p. 7, sinon en p. 6. */
export function templatePreview(dataRoot: string, bookId: string, id: string, theme?: string): TemplatePreview {
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) throw new RenderRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const read = readCollection(dataRoot);
  if (!read) throw new RenderRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(read.style, book);
  const found = templateOf(readTemplates(dataRoot, style), id);
  if ('error' in found) throw new RenderRefused(found.error);
  const { template } = found;
  const chosen = theme ?? style.variants.rotation[0]!;
  if (!Object.hasOwn(style.palette.themes, chosen)) throw new RenderRefused(`Thème inconnu : ${chosen}.`);
  const trim = book.edition.trim;
  const layout = layoutTemplate(template, trim, style.margins, template.start === 'droite' ? 7 : 6);
  return { html: renderHtml(layout, trim, style, templateContent(template, style.fiche, chosen, trim), read.pictos), layout, trim, template };
}

/** Contrôles du rendu, sur le texte à la longueur maximale. C12 ne porte ici que sur le débordement mesuré. */
const KEPT = ['C3', 'C4', 'C6', 'C7', 'C8'];

export async function controlTemplate(preview: TemplatePreview): Promise<CheckResult[]> {
  const { pdf, measures } = await renderPdf(preview.html, preview.trim);
  const facts = await readPdfFacts(pdf);
  const checks = runChecks({ facts, measures, pages: preview.layout, pack: Object.values(FONT_PACK).map(({ family, pdfName }) => ({ family, pdfName })) }).filter((c) => KEPT.includes(c.id));
  const over = measures.overflows.map((o) => `page ${o.page}, ${o.item ? `fiche, ${o.item}` : o.zone} : déborde de ${o.overMm.toFixed(2).replace('.', ',')} mm`);
  return [...checks, { id: 'C12', label: 'Texte à la longueur maximale, sans débordement', level: over.length ? 'erreur' : 'ok', details: over }];
}
