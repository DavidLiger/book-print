// src/render/pdf.ts — HTML → PDF par le Chromium de Playwright, réglages validés en PDF0 (spec §12.1), sans post-traitement.
// La taille vient de `edition.trim`. Un Chromium par export : l'outil en lance peu, et rien ne reste ouvert entre deux.
import { pageSize, type Trim } from '../templates/geometry';
import { MEASURE_SCRIPT, type Measures } from './measure';

export interface Rendered {
  pdf: Buffer;
  measures: Measures;
  chromium: string;
}

export async function renderPdf(html: string, trim: Trim): Promise<Rendered> {
  // Chargé ici : le reste de l'outil démarre sans Playwright.
  const { chromium } = await import('playwright');
  const size = pageSize(trim);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode())]).then(() => true)');
    const measures = (await page.evaluate(MEASURE_SCRIPT)) as Measures;
    const pdf = await page.pdf({ width: `${size.widthIn}in`, height: `${size.heightIn}in`, printBackground: true, preferCSSPageSize: true });
    return { pdf, measures, chromium: browser.version() };
  } finally {
    await browser.close();
  }
}
