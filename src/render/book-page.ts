// src/render/book-page.ts — rendu d'une page du livre (MP6a) : sa copie posée à sa vraie première page, le texte fixe dans la langue de
// l'édition, le titre du livre dans un titre ou un bandeau sans texte fixe, le sommaire depuis le plan, le QR du mini-jeu (`jeu.svg`,
// `<origin>/jeu`). Même HTML que le PDF. Ni recherche ni relecture : un élément sans texte fixe reste vide dans l'aperçu (C13 le dit),
// et reçoit le remplissage dans l'éditeur.
import { readCollection, type Collection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { readBookPage } from '../data/book-pages';
import { readPlan, readSubject } from '../data/subject-file';
import type { BookPlan } from '../book/plan';
import type { BookReading } from '../glbi/read';
import { readQrSvg } from '../glbi/qr-file';
import { layoutOf } from '../layout/files';
import { placeMiseEnPage } from '../layout/model';
import type { BookPageLayout, Layout } from '../layout/schema';
import type { PrintBook } from '../schema/print-book';
import type { LayoutPage, Trim } from '../templates/geometry';
import { generatedChains } from '../book/generated';
import { chainsOf } from '../layout/model';
import type { ChainText } from './flow';
import { flowHtml, type Flowed, type HtmlBuilder } from './pdf';
import { templateContent } from './gabarit';
import { applyBookFiche, RenderRefused, renderHtml, type RenderContent } from './html';
import { absentQr, subjectTitle } from './subject';

type Lang = RenderContent['lang'];

export interface BookPageContext {
  dataRoot: string;
  book: PrintBook;
  lang: Lang;
  collection: Collection;
  pageId: string;
  copy: BookPageLayout;
  layout: Layout;
  pages: LayoutPage[];
  trim: Trim;
  firstPage: number;
  /** Thème de la page : le premier du style (une page du livre n'a pas de variante). */
  theme: string;
  bookTitle: string;
  sommaire: { title: string; page: number }[];
  /** QR du mini-jeu : `null` si le livre n'a pas de jeu ou que `jeu.svg` est refusé ; la cause dans `qrFault`. */
  qr: { file: string; url: string; svg: string } | null;
  qrFault: string | null;
  qrExpectedUrl: string | null;
  /** Texte des chaînes générées (MP6b) : sources, crédits, glossaire ; et ce qui manque (glossaire non validé : C13 à l'export seulement). */
  generated: Record<string, ChainText>;
  generatedFaults: string[];
}

/** Lignes du sommaire : chaque sujet, son titre (surcharge ou scène) et sa vraie première page, dans l'ordre du plan. */
export function sommaireLines(dataRoot: string, book: PrintBook, plan: BookPlan, reading: Pick<BookReading, 'scenes'>): { title: string; page: number }[] {
  return plan.parts.flatMap((p) => {
    if (p.kind !== 'sujet' || p.firstPage === null || p.error) return [];
    const subject = readSubject(dataRoot, book.bookId, p.id);
    const title = subjectTitle(subject, reading.scenes.find((s) => s.id === subject.sceneId), book.edition.lang) || p.id;
    return [{ title, page: p.firstPage }];
  });
}

export function bookPageContext(dataRoot: string, bookId: string, pageId: string, reading: Pick<BookReading, 'scenes' | 'title' | 'origin' | 'gameQr'>, glbRoot: string | null): BookPageContext {
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) throw new RenderRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  if (!book.frontMatter.includes(pageId) && !book.backMatter.includes(pageId)) throw new RenderRefused(`La page du livre ${pageId} ne figure pas dans print-book.json.`);
  const read = readCollection(dataRoot);
  if (!read) throw new RenderRefused('collection/ absent : le créer d\'abord dans la page.');
  const collection = { ...read, style: applyBookFiche(read.style, book) };
  const copy = readBookPage(dataRoot, bookId, pageId);
  const layout = layoutOf(copy);
  const plan = readPlan(dataRoot, book);
  const part = plan.parts.find((p) => p.kind === 'page' && p.id === pageId);
  if (!part || part.firstPage === null) throw new RenderRefused(`Page du livre ${pageId} : numéro inconnu, une partie avant elle est illisible.`);
  const trim = book.edition.trim;
  const lang = book.edition.lang;
  const theme = Object.keys(collection.style.palette.themes)[0]!;
  let qr: BookPageContext['qr'] = null;
  let qrFault: string | null = null;
  const hasQr = layout.elements.some((e) => e.type === 'qr');
  if (hasQr) {
    if (!reading.gameQr) qrFault = 'Le livre n\'a pas de jeu (game absent de book.json) : pas de QR du mini-jeu.';
    else if (glbRoot) {
      const svg = readQrSvg(glbRoot, bookId, reading.gameQr.file);
      if ('svg' in svg) qr = { ...reading.gameQr, svg: svg.svg };
      else qrFault = svg.error;
    }
  }
  const generated = generatedChains(chainsOf(layout), { dataRoot, book, plan, reading });
  return {
    dataRoot,
    book,
    lang,
    collection,
    pageId,
    copy,
    layout,
    // Une page du livre se pose à sa vraie première page : un côté faux est une erreur de C16, la pose est refusée comme pour un sujet.
    pages: placeMiseEnPage(layout, trim, collection.style.margins, part.firstPage),
    trim,
    firstPage: part.firstPage,
    theme,
    bookTitle: reading.title?.[lang] ?? '',
    sommaire: sommaireLines(dataRoot, book, plan, reading),
    qr,
    qrFault,
    qrExpectedUrl: reading.origin ? `${reading.origin}/jeu` : null,
    generated: generated.chains,
    generatedFaults: generated.faults,
  };
}

/** Texte de chaque élément : le texte fixe dans la langue de l'édition ; un titre ou un bandeau sans texte fixe porte le titre du livre. */
export function fixedTexts(ctx: Pick<BookPageContext, 'layout' | 'lang' | 'bookTitle'>): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const e of ctx.layout.elements) {
    if (e.type === 'fiche' || e.type === 'qr' || e.type === 'sommaire') continue;
    const fixed = e.texteFixe?.[ctx.lang];
    texts[e.id] = fixed ?? (e.type === 'titre' || e.type === 'bandeau' ? ctx.bookTitle : '');
  }
  return texts;
}

const qrLegendOf = (ctx: Pick<BookPageContext, 'layout' | 'lang'>) => ctx.layout.elements.find((e) => e.type === 'qr')?.texteFixe?.[ctx.lang] ?? '';

/** Contenu de l'aperçu : le texte réel seulement, vide ailleurs. Les illustrations d'une page du livre gardent l'image d'attente (MP6b). */
export function bookPageContent(ctx: BookPageContext): RenderContent {
  const filler = templateContent(ctx.layout, ctx.collection.style.fiche, ctx.theme, ctx.trim);
  return {
    title: 'Aperçu',
    lang: ctx.lang,
    theme: ctx.theme,
    texts: fixedTexts(ctx),
    fiche: {},
    ficheMissing: '',
    images: filler.images,
    // Sans QR du jeu, le faux QR barré « QR absent », comme pour un sujet (ED6) : il ne peut pas passer pour un vrai.
    qrSvg: ctx.qr ? ctx.qr.svg : absentQr(),
    qrLegend: qrLegendOf(ctx),
    headings: {},
    chains: { ...filler.chains, ...ctx.generated },
    sommaire: ctx.sommaire,
  };
}

/** Contenu de l'éditeur : le texte fixe là où il est écrit, le remplissage de l'aperçu d'un modèle ailleurs. */
export function bookPageEditorContent(ctx: BookPageContext): RenderContent {
  const real = bookPageContent(ctx);
  const filler = templateContent(ctx.layout, ctx.collection.style.fiche, ctx.theme, ctx.trim);
  const written = new Set(ctx.layout.elements.filter((e) => e.texteFixe?.[ctx.lang] !== undefined || e.type === 'titre' || e.type === 'bandeau').map((e) => e.id));
  const texts = Object.fromEntries(Object.entries(filler.texts).map(([id, text]) => [id, written.has(id) ? (real.texts[id] ?? '') : text]));
  return { ...real, texts, fiche: filler.fiche, ficheMissing: filler.ficheMissing, headings: filler.headings, qrLegend: real.qrLegend || filler.qrLegend };
}

export function bookPageHtml(ctx: BookPageContext, content = bookPageContent(ctx)): string {
  return renderHtml(ctx.pages, ctx.trim, ctx.collection.style, content, ctx.collection.pictos);
}

/** Le HTML d'une page du livre avec les coupures données (MP6b) : celui de l'aperçu et du PDF. */
export function bookPageBuilder(ctx: BookPageContext): { build: HtmlBuilder; content: RenderContent } {
  const content = bookPageContent(ctx);
  return { content, build: (cuts) => bookPageHtml(ctx, cuts ? { ...content, cuts } : content) };
}

/** Le HTML final de l'aperçu d'une page du livre : ses chaînes coupées dans Chromium ; sans chaîne, sans Chromium, le même HTML qu'en MP6a. */
export function bookPagePage(ctx: BookPageContext): Promise<Flowed> {
  const { build, content } = bookPageBuilder(ctx);
  return flowHtml(build, content.chains ?? {});
}

/** Fautes sans Chromium d'une page du livre : texte fixe vide dans la langue de l'édition (C13), QR du jeu (C9 côté données). */
export function bookPageFaults(ctx: BookPageContext): string[] {
  const out: string[] = [];
  for (const e of ctx.layout.elements) {
    if (e.type === 'titre' || e.type === 'bandeau' || e.type === 'qr' || e.type === 'fiche' || e.type === 'sommaire') continue;
    if (['chapeau', 'texte', 'encadre', 'legende', 'chiffre-cle', 'etiquette'].includes(e.type) && e.chaine === undefined && e.texteFixe?.[ctx.lang] === undefined) out.push(`C13, ${e.id} : texte fixe absent en ${ctx.lang}.`);
    const fixed = e.texteFixe?.[ctx.lang];
    if (fixed !== undefined && e.maxChars !== undefined && fixed.length > e.maxChars) out.push(`C12, ${e.id} : ${fixed.length} caractères pour ${e.maxChars}.`);
  }
  for (const e of ctx.layout.elements.filter((x) => x.type === 'titre' || x.type === 'bandeau')) {
    const text = e.texteFixe?.[ctx.lang] ?? ctx.bookTitle;
    if (text === '') out.push(`C13, ${e.id} : ni texte fixe ni titre du livre.`);
    else if (e.maxChars !== undefined && text.length > e.maxChars) out.push(`C12, ${e.id} : ${text.length} caractères pour ${e.maxChars}.`);
  }
  if (ctx.layout.elements.some((e) => e.type === 'qr')) {
    if (ctx.qrFault) out.push(`C9, ${ctx.qrFault}`);
    if (qrLegendOf(ctx) === '') out.push(`C13, légende du QR : texte fixe absent en ${ctx.lang}.`);
  }
  return out;
}
