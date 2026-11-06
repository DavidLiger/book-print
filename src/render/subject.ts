// src/render/subject.ts — texte relu d'un sujet dans son gabarit (spec §5.2, étape 7). Même HTML que le PDF. L'illustration et le QR réels
// arrivent en MP4 et MP5 : un aplat neutre marqué « à venir » et un faux QR tamponné en tiennent la place. Pas d'export PDF dans ce lot.
import { ESSAI_FICHE_VALUES, ESSAI_PHRASES, fakeQr } from '../../scripts/fixtures/sujet-essai';
import { runSubjectChecks } from '../checks/content';
import type { CheckResult } from '../checks/rules';
import { readCollection, type Collection } from '../data/collection';
import { firstPageOf, QR_LEGEND_DEFAULT, readSubject } from '../data/subject-file';
import { readPrintBook } from '../data/pricing-file';
import type { SceneReading } from '../glbi/read';
import { expectedBlocks, zoneLimit, type ExpectedBlock } from '../research/blocks';
import type { PrintBook } from '../schema/print-book';
import type { StoredResearch } from '../schema/research';
import type { Subject } from '../schema/subject';
import { TEMPLATES } from '../templates';
import { layoutTemplate, type LayoutPage, type Trim } from '../templates/geometry';
import type { Template } from '../templates/model';
import { applyBookFiche, RenderRefused, renderHtml, type RenderContent } from './html';
import { measureHtml } from './pdf';

type Lang = RenderContent['lang'];

export interface SubjectContext {
  book: PrintBook;
  lang: Lang;
  collection: Collection;
  subject: Subject;
  template: Template;
  layout: LayoutPage[];
  trim: Trim;
  firstPage: number;
  title: string;
  /** Titre lu dans la scène, sans surcharge. */
  sceneTitle: string;
  legend: string;
  expected: ExpectedBlock[];
}

/** Aplat neutre, sans transparence : il marque la place de l'illustration, rien de plus. */
function placeholderImage(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 936"><rect width="612" height="936" fill="#d9d9d4"/><text x="306" y="468" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#55554f">Illustration à venir</text></svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Le faux QR de l'essai, barré d'un tampon : il ne peut pas passer pour un vrai. */
function stampedQr(): string {
  const stamp = '<g transform="rotate(-30 18.5 18.5)"><rect x="-4" y="14" width="45" height="9" fill="#ffffff"/><text x="18.5" y="21" text-anchor="middle" font-family="sans-serif" font-size="6" font-weight="700" fill="#a4261d">FACTICE</text></g>';
  return fakeQr().replace('</svg>', `${stamp}</svg>`);
}

export function subjectTitle(subject: Subject, scene: SceneReading | undefined, lang: Lang): string {
  return subject.title[lang] ?? scene?.title?.[lang] ?? '';
}

export function subjectContext(dataRoot: string, bookId: string, subjectId: string, scenes: SceneReading[]): SubjectContext {
  const { book, error } = readPrintBook(dataRoot, bookId);
  if (!book) throw new RenderRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const read = readCollection(dataRoot);
  if (!read) throw new RenderRefused('collection/ absent : le créer d\'abord dans la page.');
  const collection = { ...read, style: applyBookFiche(read.style, book) };
  const subject = readSubject(dataRoot, bookId, subjectId);
  if (subject.variant.mirror) throw new RenderRefused('Miroir : pas encore rendu, il viendra avec les gabarits suivants.');
  const template = Object.hasOwn(TEMPLATES, subject.template) ? TEMPLATES[subject.template] : undefined;
  if (!template) throw new RenderRefused(`Gabarit inconnu : ${subject.template}.`);
  if (!(subject.variant.theme in collection.style.palette.themes)) throw new RenderRefused(`Thème inconnu : ${subject.variant.theme}.`);
  const firstPage = firstPageOf(dataRoot, book, subjectId);
  const trim = book.edition.trim;
  const lang = book.edition.lang;
  const scene = scenes.find((s) => s.id === subject.sceneId);
  return {
    book,
    lang,
    collection,
    subject,
    template,
    layout: layoutTemplate(template, trim, collection.style.margins, firstPage),
    trim,
    firstPage,
    title: subjectTitle(subject, scene, lang),
    sceneTitle: scene?.title?.[lang] ?? '',
    legend: subject.qrLegend?.[lang] ?? QR_LEGEND_DEFAULT[lang],
    expected: expectedBlocks(template, collection.style.fiche, lang),
  };
}

/** Un bloc absent laisse sa zone vide : c'est C13 qui le dit, l'aperçu doit rester visible. */
export function subjectContent(ctx: SubjectContext): RenderContent {
  const texts: Record<string, string> = {};
  const fiche: Record<string, string> = {};
  for (const zone of ctx.template.sheets.flatMap((s) => s.zones)) if (zone.type !== 'fiche') texts[zone.id] = '';
  for (const zone of ctx.template.sheets.flatMap((s) => s.zones)) if (zone.type === 'titre') texts[zone.id] = ctx.title;
  for (const block of ctx.subject.blocks) {
    const text = block.text[ctx.lang] ?? '';
    if (block.item) fiche[block.item] = text;
    else texts[block.zone] = text;
  }
  const images = Object.fromEntries(ctx.template.sheets.flatMap((s) => s.zones).filter((z) => z.type === 'illustration').map((z) => [z.id, placeholderImage()]));
  return { title: 'Aperçu', lang: ctx.lang, theme: ctx.subject.variant.theme, texts, fiche, ficheMissing: '', images, qrSvg: stampedQr(), qrLegend: ctx.legend };
}

export const subjectHtml = (ctx: SubjectContext) => renderHtml(ctx.layout, ctx.trim, ctx.collection.style, subjectContent(ctx), ctx.collection.pictos);

/** C10 et C13 viennent des données, C12 de Chromium : c'est pourquoi ces contrôles sont une action, pas un calcul du parcours. */
export async function controlSubject(ctx: SubjectContext, research: StoredResearch | null): Promise<CheckResult[]> {
  const measures = await measureHtml(subjectHtml(ctx));
  return runSubjectChecks({
    blocks: ctx.subject.blocks,
    expected: ctx.expected,
    lang: ctx.lang,
    title: ctx.title,
    titleMax: zoneLimit(ctx.template, 'titre'),
    legend: ctx.legend,
    legendMax: zoneLimit(ctx.template, 'qr'),
    claims: research?.claims ?? [],
    measures,
    essaiPhrases: ESSAI_PHRASES,
    essaiValues: ESSAI_FICHE_VALUES,
  });
}
