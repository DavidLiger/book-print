// src/render/pdf.ts — HTML → PDF par le Chromium de Playwright, réglages validés en PDF0 (spec §12.1), sans post-traitement.
// La taille vient de `edition.trim`. Un Chromium par export : l'outil en lance peu, et rien ne reste ouvert entre deux.
// ED2 : une mise en page à chaîne est rendue en deux passes dans la même page (spec §24.5) : la première coupe le texte (`render/flow.ts`),
// la seconde charge le HTML final, déjà coupé, qui est mesuré et imprimé. Sans chaîne, rien ne change : une seule passe, le même HTML.
import { pageSize, type Trim } from '../templates/geometry';
import { flowScript, type ChainCut, type ChainText } from './flow';
import { MEASURE_SCRIPT, type Measures } from './measure';

export interface Rendered {
  pdf: Buffer;
  measures: Measures;
  chromium: string;
}

/** Le HTML d'une mise en page : sans coupures, la première passe ; avec, le HTML final. */
export type HtmlBuilder = (cuts?: Record<string, number[]>) => string;

export interface Flowed {
  html: string;
  /** Par chaîne : coupures, mots restés après la dernière boîte, mots en tout. */
  flow: Record<string, ChainCut>;
}

async function load(page: import('playwright').Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate('Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode())]).then(() => true)');
}

async function inPage<T>(html: string, run: (page: import('playwright').Page, browser: import('playwright').Browser) => Promise<T>): Promise<T> {
  // Chargé ici : le reste de l'outil démarre sans Playwright.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await load(page, html);
    return await run(page, browser);
  } finally {
    await browser.close();
  }
}

const hasChains = (chains: Record<string, ChainText>) => Object.keys(chains).length > 0;

/** Première passe dans la page déjà chargée, puis le HTML final chargé à sa place. */
async function flowIn(page: import('playwright').Page, build: HtmlBuilder, chains: Record<string, ChainText>): Promise<Flowed> {
  // Les boîtes sont vides : les polices des intertitres et de la lettrine ne sont pas encore chargées. Sans elles, la mesure serait faite avec
  // une police de remplacement, et la coupure serait fausse.
  await page.evaluate('Promise.all(Array.from(document.fonts).map((f) => f.load())).then(() => true)');
  const flow = (await page.evaluate(flowScript(chains))) as Record<string, ChainCut>;
  const html = build(Object.fromEntries(Object.entries(flow).map(([id, c]) => [id, c.ends])));
  await load(page, html);
  return { html, flow };
}

/** Le HTML final d'une mise en page : sans chaîne, sans Chromium. */
export async function flowHtml(build: HtmlBuilder, chains: Record<string, ChainText>): Promise<Flowed> {
  if (!hasChains(chains)) return { html: build(), flow: {} };
  return inPage(build(), (page) => flowIn(page, build, chains));
}

export function renderPdf(html: string, trim: Trim): Promise<Rendered> {
  return renderFlowedPdf(() => html, {}, trim);
}

/** PDF et mesures d'une mise en page, coupée d'abord si elle a des chaînes, dans la même page Chromium. */
export function renderFlowedPdf(build: HtmlBuilder, chains: Record<string, ChainText>, trim: Trim): Promise<Rendered & Flowed> {
  const size = pageSize(trim);
  return inPage(build(), async (page, browser) => {
    const flowed = hasChains(chains) ? await flowIn(page, build, chains) : { html: build(), flow: {} };
    const measures = (await page.evaluate(MEASURE_SCRIPT)) as Measures;
    const pdf = await page.pdf({ width: `${size.widthIn}in`, height: `${size.heightIn}in`, printBackground: true, preferCSSPageSize: true });
    return { pdf, measures, chromium: browser.version(), ...flowed };
  });
}

/** Les mesures seules, sans PDF : C12 sur un sujet (§16.6). */
export function measureHtml(html: string): Promise<Measures> {
  return measureFlowed(() => html, {}).then((r) => r.measures);
}

export function measureFlowed(build: HtmlBuilder, chains: Record<string, ChainText>): Promise<Flowed & { measures: Measures }> {
  return inPage(build(), async (page) => {
    const flowed = hasChains(chains) ? await flowIn(page, build, chains) : { html: build(), flow: {} };
    return { ...flowed, measures: (await page.evaluate(MEASURE_SCRIPT)) as Measures };
  });
}
