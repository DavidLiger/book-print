// scripts/fixtures/essai-2a.ts — rendu du gabarit 2A sur contenu factice, pour les tests. L'étape Essai et son export ont disparu en ED6 :
// il ne reste que ce qui sert à rendre une mise en page de test (la production n'en a plus l'usage ; le PDF d'export revient avec MP6).
import { readPdfFacts } from '../../src/checks/pdf-facts';
import { runChecks, type CheckResult } from '../../src/checks/rules';
import type { Collection } from '../../src/data/collection';
import { placeMiseEnPage, type MiseEnPage } from '../../src/layout/model';
import { fillerHeadings, fillerImages, fillerTexts } from '../../src/render/gabarit';
import { renderHtml, RenderRefused } from '../../src/render/html';
import { packFonts } from '../../src/render/pdf-checks';
import { renderPdf } from '../../src/render/pdf';
import { pageSize, type LayoutPage, type Trim } from '../../src/templates/geometry';
import { essaiContent, essaiSubject, ESSAI_FIRST_PAGE } from './sujet-essai';

export { packFonts };

export interface Essai {
  html: string;
  layout: LayoutPage[];
  trim: Trim;
  theme: string;
}

export function buildEssai(trim: Trim, collection: Collection, theme: string, template: MiseEnPage): Essai {
  const subject = essaiSubject(theme);
  if (subject.variant.mirror) throw new RenderRefused('Miroir : pas encore rendu, il viendra avec les gabarits suivants.');
  const layout = placeMiseEnPage(template, trim, collection.style.margins, ESSAI_FIRST_PAGE);
  const content = essaiContent(theme, trim);
  const headings = fillerHeadings(template);
  const filled = { ...content, texts: { ...fillerTexts(template), ...content.texts }, images: { ...fillerImages(template, trim), ...content.images }, ...(Object.keys(headings).length ? { headings } : {}) };
  return { html: renderHtml(layout, trim, collection.style, filled, collection.pictos), layout, trim, theme };
}

export interface EssaiResult {
  checks: CheckResult[];
  pageSizeIn: { widthIn: number; heightIn: number };
  pages: { number: number; widthPt: number; heightPt: number }[];
  fonts: { name: string; how: string }[];
  sizeBytes: number;
  chromium: string;
}

export async function renderEssai(essai: Essai): Promise<EssaiResult & { pdf: Buffer }> {
  const { pdf, measures, chromium } = await renderPdf(essai.html, essai.trim);
  const facts = await readPdfFacts(pdf);
  const fonts = [...new Map(facts.fonts.map((f) => [f.name, { name: f.name, how: f.how }])).values()];
  return {
    pdf,
    checks: runChecks({ facts, measures, pages: essai.layout, pack: packFonts() }),
    pageSizeIn: pageSize(essai.trim),
    pages: facts.pages.map((p, i) => ({ ...p, number: essai.layout[i]?.number ?? p.number })),
    fonts,
    sizeBytes: facts.sizeBytes,
    chromium,
  };
}
