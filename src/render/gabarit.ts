// src/render/gabarit.ts — aperçu d'un gabarit de la collection (GB1, étape Gabarits). Contenu synthétique, à la longueur maximale de chaque zone :
// ce qui tient là tiendra avec un vrai texte. Même HTML que le PDF. Le contrôle rend le PDF en mémoire, sans rien écrire, et n'est pas conservé.
import { fakeQr, placeholderImage } from './placeholders';
import { readPdfFacts } from '../checks/pdf-facts';
import type { CheckResult } from '../checks/rules';
import { readCollection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { c17Overlaps } from '../checks/overlaps';
import { chainsOf, elementsOf, placeMiseEnPage, previewFirstPage, type MiseEnPage } from '../layout/model';
import { chainFaults } from '../checks/content';
import { readTemplates, templateOf } from '../templates/files';
import type { LayoutPage, Trim } from '../templates/geometry';
import { pdfChecks } from './pdf-checks';
import type { ChainText } from './flow';
import { applyBookFiche, renderHtml, RenderRefused, type RenderContent } from './html';
import { flowHtml, renderFlowedPdf, type Flowed, type HtmlBuilder } from './pdf';

/** Texte de remplissage, clairement synthétique, à exactement `n` caractères. */
const FILLER = 'Texte de remplissage du gabarit, sans contenu réel. ';
export function fillerText(n: number): string {
  let out = '';
  while (out.length < n) out += FILLER;
  out = out.slice(0, n);
  // Une fin sur une espace compterait un caractère invisible : un point le remplace.
  return out.endsWith(' ') ? `${out.slice(0, -1)}.` : out;
}

const zonesOf = (template: MiseEnPage) => elementsOf(template);

/** Textes de remplissage de toutes les zones à texte, à leur longueur maximale. */
export function fillerTexts(template: MiseEnPage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zone of zonesOf(template)) {
    const max = zone.maxChars;
    if (zone.type !== 'qr' && zone.type !== 'fiche' && max !== undefined) out[zone.id] = fillerText(max);
  }
  return out;
}

/** L'image d'essai dans chaque zone d'illustration. */
/** En-têtes d'encadré écrits par la recherche (ED1, `headingMaxChars`), à leur longueur maximale. */
export function fillerHeadings(template: MiseEnPage): Record<string, string> {
  return Object.fromEntries(zonesOf(template).flatMap((z) => (z.headingMaxChars === undefined ? [] : [[z.id, fillerText(z.headingMaxChars)]])));
}

/** Chaînes au texte de remplissage (ED2) : chaque paragraphe à son `maxChars`, chaque intertitre à son `headingMaxChars`. */
export function fillerChains(template: MiseEnPage): Record<string, ChainText> {
  return Object.fromEntries(
    chainsOf(template).map((c) => [
      c.id,
      { cadres: c.cadres, lettrine: c.lettrine === true, paragraphs: c.paragraphes.map((p) => ({ id: p.id, heading: p.intertitre ? fillerText(p.headingMaxChars!) : null, text: fillerText(p.maxChars) })) },
    ]),
  );
}

export function fillerImages(template: MiseEnPage, trim: Trim): Record<string, string> {
  return Object.fromEntries(zonesOf(template).filter((z) => z.type === 'illustration').map((z) => [z.id, placeholderImage(trim)]));
}

/** Contenu de l'aperçu d'un gabarit : remplissage partout, valeurs de fiche et légende du QR à leur longueur maximale. */
export function templateContent(template: MiseEnPage, fiche: { id: string }[], theme: string, trim: Trim): RenderContent {
  const fiches = zonesOf(template).filter((z) => z.type === 'fiche');
  const itemMax = Math.max(1, ...fiches.map((z) => z.itemMaxChars ?? 1));
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
    qrLegend: fillerText(qr?.maxChars ?? 20),
    headings: fillerHeadings(template),
    chains: fillerChains(template),
  };
}

export interface TemplatePreview {
  /** Le HTML sans coupure des chaînes : le HTML final quand la mise en page n'a pas de chaîne. Sinon, passer par `flowedPreview`. */
  html: string;
  layout: LayoutPage[];
  trim: Trim;
  template: MiseEnPage;
  /** Le HTML avec les coupures de la première passe (ED2). */
  build: HtmlBuilder;
  chains: Record<string, ChainText>;
}

/** Un aperçu prêt à rendre : les mêmes coupures pour l'aperçu et le PDF. */
export function previewOf(layout: LayoutPage[], trim: Trim, template: MiseEnPage, style: Parameters<typeof renderHtml>[2], content: RenderContent, pictos: Record<string, string>): TemplatePreview {
  const build: HtmlBuilder = (cuts) => renderHtml(layout, trim, style, cuts ? { ...content, cuts } : content, pictos);
  return { html: build(), layout, trim, template, build, chains: content.chains ?? {} };
}

/** Le HTML final de l'aperçu : Chromium seulement s'il y a une chaîne à couper. */
export const flowedPreview = (p: TemplatePreview): Promise<Flowed> => flowHtml(p.build, p.chains);

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
  const layout = placeMiseEnPage(template, trim, style.margins, previewFirstPage(template));
  return previewOf(layout, trim, template, style, templateContent(template, style.fiche, chosen, trim), read.pictos);
}

/** Contrôles du rendu, sur le texte à la longueur maximale. C12 ne porte ici que sur le débordement mesuré. */
export async function controlTemplate(preview: TemplatePreview): Promise<CheckResult[]> {
  const { pdf, measures, flow } = await renderFlowedPdf(preview.build, preview.chains, preview.trim);
  const facts = await readPdfFacts(pdf);
  const checks = pdfChecks({ facts, measures, pages: preview.layout });
  const over = [
    ...measures.overflows.map((o) => `page ${o.page}, ${o.item ? `fiche, ${o.item}` : o.zone} : déborde de ${o.overMm.toFixed(2).replace('.', ',')} mm`),
    ...chainFaults(flow, preview.chains, chainsOf(preview.template)),
  ];
  return [...checks, { id: 'C12', label: 'Texte à la longueur maximale, sans débordement', level: over.length ? 'erreur' : 'ok', details: over }, c17Overlaps(preview.layout)];
}
