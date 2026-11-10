// src/render/subject.ts — texte relu et illustrations d'un sujet dans son gabarit (spec §5.2, étape 7). Même HTML que le PDF. Une zone sans image
// garde un aplat neutre marqué « à venir ». Le QR réel arrive en MP5 : un faux QR tamponné en tient la place. Pas d'export PDF du sujet.
import fs from 'node:fs';
import { ESSAI_FICHE_VALUES, ESSAI_PHRASES, fakeQr } from '../../scripts/fixtures/sujet-essai';
import { runSubjectChecks } from '../checks/content';
import type { CheckResult } from '../checks/rules';
import { c5Resolution, c11Rights, ppiOf, type PlacedImage } from '../checks/images';
import { readCollection, type Collection } from '../data/collection';
import { illustrationFile } from '../data/illustration-file';
import { firstPageOf, QR_LEGEND_DEFAULT, readSubject, readSubjectLayout } from '../data/subject-file';
import { layoutOf } from '../layout/files';
import { elementsOf, placeMiseEnPage, type MiseEnPage } from '../layout/model';
import type { SubjectLayout } from '../layout/schema';
import { readPrintBook } from '../data/pricing-file';
import type { SceneReading } from '../glbi/read';
import { placement, targetPixels, visibleCrop, type Crop, type Placement, type Size, type ZoneSizeMm } from '../images/crop';
import { expectedBlocks, zoneLimit, type ExpectedBlock } from '../research/blocks';
import { allEntries, illustrationRights, readBookRights } from '../rights/registry';
import type { PrintBook } from '../schema/print-book';
import type { StoredResearch } from '../schema/research';
import type { Illustration, Subject } from '../schema/subject';
import { readTemplates, templateOf } from '../templates/files';
import type { LayoutPage, LayoutZone, Trim } from '../templates/geometry';
import { applyBookFiche, RenderRefused, renderHtml, type RenderContent } from './html';
import { measureHtml } from './pdf';

type Lang = RenderContent['lang'];

export interface SubjectContext {
  dataRoot: string;
  book: PrintBook;
  lang: Lang;
  collection: Collection;
  subject: Subject;
  /** La mise en page du sujet : sa copie (`layout.json`, ED1), ou le gabarit de la collection pour un sujet créé avant ED1. */
  template: MiseEnPage;
  /** D'où vient la mise en page. */
  source: 'layout.json' | 'gabarit';
  /** Origine de la copie, `null` pour un sujet créé avant ED1. */
  modele: SubjectLayout['modele'] | null;
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
  // La copie du sujet d'abord (ED1) ; sans elle, le gabarit relu dans la collection (GB1) : absent ou invalide, le sujet est en erreur, nommé.
  const copy = readSubjectLayout(dataRoot, bookId, subjectId);
  let template: MiseEnPage;
  if (copy) template = layoutOf(copy);
  else {
    const found = templateOf(readTemplates(dataRoot, collection.style), subject.template);
    if ('error' in found) throw new RenderRefused(found.error);
    template = found.template;
  }
  if (!(subject.variant.theme in collection.style.palette.themes)) throw new RenderRefused(`Thème inconnu : ${subject.variant.theme}.`);
  const firstPage = firstPageOf(dataRoot, book, subjectId);
  const trim = book.edition.trim;
  const lang = book.edition.lang;
  const scene = scenes.find((s) => s.id === subject.sceneId);
  return {
    dataRoot,
    book,
    lang,
    collection,
    subject,
    template,
    source: copy ? 'layout.json' : 'gabarit',
    modele: copy?.modele ?? null,
    layout: placeMiseEnPage(template, trim, collection.style.margins, firstPage),
    trim,
    firstPage,
    title: subjectTitle(subject, scene, lang),
    sceneTitle: scene?.title?.[lang] ?? '',
    legend: subject.qrLegend?.[lang] ?? QR_LEGEND_DEFAULT[lang],
    expected: expectedBlocks(template, collection.style.fiche, lang),
  };
}

/** Une illustration à cheval est posée sur deux pages : elle n'est comptée qu'une fois, sur sa première page, à sa taille entière. */
export const illustrationZones = (ctx: SubjectContext): LayoutZone[] => ctx.layout.flatMap((p) => p.zones).filter((z) => z.type === 'illustration' && z.double !== 'fin');
const sizeOf = (zone: LayoutZone): ZoneSizeMm => ({ widthMm: zone.rect.right - zone.rect.left, heightMm: zone.rect.bottom - zone.rect.top });

export interface ZoneImage {
  zone: string;
  size: ZoneSizeMm;
  /** Pixels à fournir pour 300 ppp dans cette zone, à ce format. */
  target: Size;
  illustration: Illustration | null;
  /** Dimensions lues dans le fichier. `null` : pas d'image utilisable. */
  image: Size | null;
  /** Le sujet cite une image que le disque ne donne pas. Les illustrations sont hors git : un clone n'en a aucune. */
  fault: string | null;
  crop: Crop | null;
  ppi: number | null;
  /** Droits rattachés ; `null` : pas d'entrée dans `rights.json`. */
  rights: string[] | null;
}

export function zoneImages(ctx: SubjectContext): ZoneImage[] {
  const { dataRoot, book, subject } = ctx;
  const rights = readBookRights(dataRoot, book.bookId);
  return illustrationZones(ctx).map((zone): ZoneImage => {
    const size = sizeOf(zone);
    const illustration = subject.illustrations.find((i) => i.zone === zone.id) ?? null;
    const base = { zone: zone.id, size, target: targetPixels(size), illustration, image: null, fault: null, crop: null, ppi: null, rights: illustrationRights(rights, subject.id, zone.id)?.rights ?? null };
    if (!illustration) return base;
    const file = illustrationFile(dataRoot, book.bookId, subject.id, zone.id);
    if (file.state === 'absent') return { ...base, fault: `${zone.id} : fichier absent du disque, le redéposer.` };
    if (file.state === 'refuse') return { ...base, fault: `${zone.id} : ${file.message}` };
    const image = { width: file.header.width, height: file.header.height };
    const placed: PlacedImage = { zone: zone.id, image, size, framing: illustration.framing };
    return { ...base, image, crop: visibleCrop(image, size, illustration.framing), ppi: ppiOf(placed) };
  });
}

export interface ImageChecks {
  zones: ZoneImage[];
  checks: CheckResult[];
}

/** Images rattachées à une zone que le gabarit n'a plus (GB1) : elles restent dans `subject.json`, rien n'est supprimé. */
export function strayIllustrations(ctx: SubjectContext): string[] {
  const zones = new Set(illustrationZones(ctx).map((z) => z.id));
  return ctx.subject.illustrations.filter((i) => !zones.has(i.zone)).map((i) => `${i.zone} : image rattachée à une zone d'illustration absente du gabarit ${ctx.template.id}.`);
}

/** C5 sur ce qui a une image ; C11 sur ce que le sujet cite. Aucun Chromium : le parcours peut les calculer à chaque lecture. */
export function imageChecks(ctx: SubjectContext): ImageChecks {
  const zones = zoneImages(ctx);
  const registry = allEntries(ctx.collection.rights, readBookRights(ctx.dataRoot, ctx.book.bookId));
  const placed = zones.flatMap((z) => (z.image && z.illustration ? [{ zone: z.zone, image: z.image, size: z.size, framing: z.illustration.framing }] : []));
  const linked = zones.filter((z) => z.illustration).map((z) => ({ zone: z.zone, rights: z.rights }));
  return { zones, checks: [c5Resolution(placed), c11Rights(linked, registry)] };
}

/** L'image réelle, en `data:`, et son cadrage ; l'aplat si la zone n'a pas d'image utilisable : c'est l'étape Illustrations qui le signale. */
function subjectImages(ctx: SubjectContext): { images: Record<string, string>; placements: Record<string, Placement> } {
  const images: Record<string, string> = {};
  const placements: Record<string, Placement> = {};
  for (const z of zoneImages(ctx)) {
    const file = z.image && illustrationFile(ctx.dataRoot, ctx.book.bookId, ctx.subject.id, z.zone);
    if (z.image && z.illustration && file?.state === 'ok') {
      images[z.zone] = `data:image/png;base64,${fs.readFileSync(file.path).toString('base64')}`;
      placements[z.zone] = placement(z.image, z.size, visibleCrop(z.image, z.size, z.illustration.framing));
    } else images[z.zone] = placeholderImage();
  }
  return { images, placements };
}

/** Un bloc absent laisse sa zone vide : c'est C13 qui le dit, l'aperçu doit rester visible. */
export function subjectContent(ctx: SubjectContext): RenderContent {
  const texts: Record<string, string> = {};
  const fiche: Record<string, string> = {};
  for (const zone of elementsOf(ctx.template)) if (zone.type !== 'fiche') texts[zone.id] = '';
  for (const zone of elementsOf(ctx.template)) if (zone.type === 'titre' || zone.type === 'bandeau') texts[zone.id] = ctx.title;
  for (const block of ctx.subject.blocks) {
    const text = block.text[ctx.lang] ?? '';
    if (block.item) fiche[block.item] = text;
    else texts[block.zone] = text;
  }
  return { title: 'Aperçu', lang: ctx.lang, theme: ctx.subject.variant.theme, texts, fiche, ficheMissing: '', ...subjectImages(ctx), qrSvg: stampedQr(), qrLegend: ctx.legend };
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
