// src/render/subject.ts — texte relu et illustrations d'un sujet dans son gabarit (spec §5.2, étape 7). Même HTML que le PDF. Une zone sans image
// garde un aplat neutre marqué « à venir ». Le QR réel arrive en MP5 : un faux QR tamponné en tient la place. Pas d'export PDF du sujet.
import fs from 'node:fs';
import { fakeQr, PLACEHOLDER_FICHE_VALUES, PLACEHOLDER_PHRASES } from './placeholders';
import { runSubjectChecks } from '../checks/content';
import { c17Overlaps } from '../checks/overlaps';
import { readPdfFacts } from '../checks/pdf-facts';
import { pdfChecks } from './pdf-checks';
import { c9Qr, decodeQr, qrDataFaults } from '../checks/qr';
import type { Measures } from './measure';
import type { CheckResult } from '../checks/rules';
import { c5Resolution, c11Rights, ppiOf, type PlacedImage } from '../checks/images';
import { readCollection, type Collection } from '../data/collection';
import { illustrationFile } from '../data/illustration-file';
import { firstPageOf, QR_LEGEND_DEFAULT, readSubject, readSubjectLayout } from '../data/subject-file';
import { layoutOf } from '../layout/files';
import { chainsOf, elementsOf, placeMiseEnPage, type MiseEnPage } from '../layout/model';
import { subjectContour, withOutlines } from '../data/contour-file';
import type { Part } from '../images/contour';
import type { SubjectLayout } from '../layout/schema';
import { readPrintBook } from '../data/pricing-file';
import type { SceneReading } from '../glbi/read';
import { readQrSvg } from '../glbi/qr-file';
import { containPpi, placement, targetPixels, visibleCrop, type Crop, type Placement, type Size, type ZoneSizeMm } from '../images/crop';
import { expectedBlocks, zoneLimit, type ExpectedBlock } from '../research/blocks';
import { allEntries, illustrationRights, readBookRights } from '../rights/registry';
import type { PrintBook } from '../schema/print-book';
import type { StoredResearch } from '../schema/research';
import type { Illustration, Subject } from '../schema/subject';
import { readTemplates, templateOf } from '../templates/files';
import type { LayoutPage, LayoutZone, Trim } from '../templates/geometry';
import { templateContent } from './gabarit';
import type { ChainText } from './flow';
import { blockId } from '../schema/block';
import { applyBookFiche, RenderRefused, renderHtml, type RenderContent } from './html';
import { captureQr, flowHtml, renderFlowedPdf, type Flowed, type HtmlBuilder } from './pdf';

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
  /** Le QR réel de la scène, lu dans `dist/qr/<bookId>/` (ED6) ; `null` : absent ou illisible, l'aperçu montre un faux QR marqué « QR absent ». */
  qr: { file: string; url: string; svg: string } | null;
  /** Pourquoi le SVG du QR a été refusé, s'il existe. */
  qrFault: string | null;
  /** `<origin>/s/<sceneId>` ; `null` : origine inconnue (lecture sans GLBInterpreter). */
  qrExpectedUrl: string | null;
  /** Fichier attendu dans `dist/qr/<bookId>/`, pour nommer l'absence. */
  qrExpectedFile: string;
}

/** Où lire le QR réel : la racine de GLBInterpreter et l'origine du livre (`book.json`). */
export interface QrSource {
  glbRoot: string;
  origin: string | null;
}

/** Aplat neutre, sans transparence : il marque la place de l'illustration, rien de plus. */
function placeholderImage(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 936"><rect width="612" height="936" fill="#d9d9d4"/><text x="306" y="468" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#55554f">Illustration à venir</text></svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Le faux QR, barré d'un tampon « QR absent » : il ne peut pas passer pour un vrai. */
function absentQr(): string {
  const stamp = '<g transform="rotate(-30 18.5 18.5)"><rect x="-4" y="14" width="45" height="9" fill="#ffffff"/><text x="18.5" y="21" text-anchor="middle" font-family="sans-serif" font-size="6" font-weight="700" fill="#a4261d">QR absent</text></g>';
  return fakeQr().replace('</svg>', `${stamp}</svg>`);
}

export function subjectTitle(subject: Subject, scene: SceneReading | undefined, lang: Lang): string {
  return subject.title[lang] ?? scene?.title?.[lang] ?? '';
}

export function subjectContext(dataRoot: string, bookId: string, subjectId: string, scenes: SceneReading[], qrSource: QrSource | null = null): SubjectContext {
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
  let qr: SubjectContext['qr'] = null;
  let qrFault: string | null = null;
  if (scene?.qr && qrSource) {
    const read = readQrSvg(qrSource.glbRoot, bookId, scene.qr.file);
    if ('svg' in read) qr = { ...scene.qr, svg: read.svg };
    else qrFault = read.error;
  }
  return {
    dataRoot,
    book,
    lang,
    collection,
    subject,
    template,
    source: copy ? 'layout.json' : 'gabarit',
    modele: copy?.modele ?? null,
    // Le contour de chaque détouré qui a son image (ED2) : rendu, habillage et C17 le suivent.
    layout: withOutlines(placeMiseEnPage(template, trim, collection.style.margins, firstPage), dataRoot, bookId, subjectId, (zone) => subject.illustrations.some((i) => i.zone === zone)),
    trim,
    firstPage,
    title: subjectTitle(subject, scene, lang),
    sceneTitle: scene?.title?.[lang] ?? '',
    legend: subject.qrLegend?.[lang] ?? QR_LEGEND_DEFAULT[lang],
    expected: expectedBlocks(template, collection.style.fiche, lang),
    qr,
    qrFault,
    qrExpectedUrl: qrSource?.origin && subject.sceneId ? `${qrSource.origin}/s/${subject.sceneId}` : null,
    qrExpectedFile: scene?.qr?.file ?? `NN-${subject.sceneId}.svg`,
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
  /** Image générée par l'outil (ED5) : C11 n'exige un modèle d'IA que pour elle. */
  aiGenerated: boolean;
  /** Détouré (ED2) : image entière dans sa boîte, sans cadrage, et les parties opaques que le contour découpe. */
  detoure: boolean;
  parts: Part[];
}

export function zoneImages(ctx: SubjectContext): ZoneImage[] {
  const { dataRoot, book, subject } = ctx;
  const rights = readBookRights(dataRoot, book.bookId);
  return illustrationZones(ctx).map((zone): ZoneImage => {
    const size = sizeOf(zone);
    const illustration = subject.illustrations.find((i) => i.zone === zone.id) ?? null;
    const detoure = zone.detoure === true;
    const base = { zone: zone.id, size, target: targetPixels(size), illustration, image: null, fault: null, crop: null, ppi: null, rights: illustrationRights(rights, subject.id, zone.id)?.rights ?? null, aiGenerated: illustrationRights(rights, subject.id, zone.id)?.aiGenerated ?? true, detoure, parts: [] };
    if (!illustration) return base;
    const file = illustrationFile(dataRoot, book.bookId, subject.id, zone.id);
    if (file.state === 'absent') return { ...base, fault: `${zone.id} : fichier absent du disque, le redéposer.` };
    if (file.state === 'refuse') return { ...base, fault: `${zone.id} : ${file.message}` };
    const image = { width: file.header.width, height: file.header.height };
    if (detoure) {
      // Le contour fait partie de l'image : sans lui, ou s'il ne correspond plus au PNG, l'image est à redéposer.
      const contour = subjectContour(dataRoot, book.bookId, subject.id, zone.id);
      if (!contour || contour.state === 'absent') return { ...base, image, fault: `${zone.id} : contour absent, redéposer l'image.` };
      if (contour.state === 'refuse') return { ...base, image, fault: `${zone.id} : ${contour.message}` };
      return { ...base, image, ppi: containPpi(image, size), parts: contour.contour.autresParties };
    }
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
  const placed = zones.flatMap((z) => (z.image && z.illustration && !z.fault ? [{ zone: z.zone, image: z.image, size: z.size, framing: z.illustration.framing, contain: z.detoure }] : []));
  const linked = zones.filter((z) => z.illustration).map((z) => ({ zone: z.zone, rights: z.rights, aiGenerated: z.aiGenerated }));
  return { zones, checks: [c5Resolution(placed), c11Rights(linked, registry)] };
}

/** L'image réelle, en `data:`, et son cadrage ; l'aplat si la zone n'a pas d'image utilisable : c'est l'étape Illustrations qui le signale. */
function subjectImages(ctx: SubjectContext): { images: Record<string, string>; placements: Record<string, Placement> } {
  const images: Record<string, string> = {};
  const placements: Record<string, Placement> = {};
  const outlined = new Set(ctx.layout.flatMap((p) => p.zones).filter((z) => z.outline).map((z) => z.id));
  for (const z of zoneImages(ctx)) {
    const file = z.image && illustrationFile(ctx.dataRoot, ctx.book.bookId, ctx.subject.id, z.zone);
    // Un détouré sans contour valide garde l'aplat : son fond blanc ne doit pas passer pour l'image découpée.
    if (z.detoure) {
      images[z.zone] = outlined.has(z.zone) && file?.state === 'ok' ? `data:image/png;base64,${fs.readFileSync(file.path).toString('base64')}` : placeholderImage();
      continue;
    }
    if (z.image && z.illustration && file?.state === 'ok') {
      images[z.zone] = `data:image/png;base64,${fs.readFileSync(file.path).toString('base64')}`;
      placements[z.zone] = placement(z.image, z.size, visibleCrop(z.image, z.size, z.illustration.framing));
    } else images[z.zone] = placeholderImage();
  }
  return { images, placements };
}

/**
 * Texte réel des chaînes (ED4) : le bloc `paragraphe` de chaque paragraphe, dans leur ordre ; son intertitre pour un paragraphe qui en a un.
 * Un bloc absent laisse son paragraphe vide, un en-tête vide n'est pas rendu : C13 les nomme. `fill` donne le remplissage d'un paragraphe ou
 * d'un intertitre sans texte réel (éditeur d'un sujet, ED3).
 */
export function subjectChains(ctx: SubjectContext, fill?: Record<string, ChainText>): Record<string, ChainText> {
  return Object.fromEntries(
    chainsOf(ctx.template).map((c) => {
      const filler = fill?.[c.id];
      const paragraphs = c.paragraphes.map((p, i) => {
        const block = ctx.subject.blocks.find((b) => b.type === 'paragraphe' && b.id === blockId(c.id, p.id));
        const text = block?.text[ctx.lang] ?? '';
        const heading = block?.heading?.[ctx.lang] ?? '';
        const spare = filler?.paragraphs[i];
        return {
          id: p.id,
          heading: p.intertitre ? (heading !== '' ? heading : (spare?.heading ?? null)) : null,
          text: text !== '' ? text : (spare?.text ?? ''),
        };
      });
      return [c.id, { cadres: c.cadres, lettrine: c.lettrine === true, paragraphs }];
    }),
  );
}

/** Un bloc absent laisse sa zone vide : c'est C13 qui le dit, l'aperçu doit rester visible. */
export function subjectContent(ctx: SubjectContext): RenderContent {
  const texts: Record<string, string> = {};
  const fiche: Record<string, string> = {};
  const headings: Record<string, string> = {};
  for (const zone of elementsOf(ctx.template)) if (zone.type !== 'fiche') texts[zone.id] = '';
  for (const zone of elementsOf(ctx.template)) if (zone.type === 'titre' || zone.type === 'bandeau') texts[zone.id] = ctx.title;
  for (const block of ctx.subject.blocks) {
    const text = block.text[ctx.lang] ?? '';
    if (block.item) fiche[block.item] = text;
    else if (block.type === 'paragraphe') continue;
    else texts[block.zone] = text;
    // L'en-tête écrit d'un encadré (ED4), dans la langue de l'édition.
    if (block.heading !== undefined && (block.heading[ctx.lang] ?? '') !== '') headings[block.zone] = block.heading[ctx.lang]!;
  }
  return { title: 'Aperçu', lang: ctx.lang, theme: ctx.subject.variant.theme, texts, fiche, ficheMissing: '', ...subjectImages(ctx), qrSvg: ctx.qr ? ctx.qr.svg : absentQr(), qrLegend: ctx.legend, headings, chains: subjectChains(ctx) };
}

/**
 * Contenu de l'éditeur d'un sujet (ED3) : le texte réel là où il existe (titre, blocs importés, paragraphes et en-têtes, légende du QR, images),
 * le remplissage de l'aperçu d'un modèle ailleurs (éléments sans bloc, sujet sans recherche, QR).
 */
export function editorContent(ctx: SubjectContext): RenderContent {
  const real = subjectContent(ctx);
  const filler = templateContent(ctx.template, ctx.collection.style.fiche, ctx.subject.variant.theme, ctx.trim);
  const zones = new Set(ctx.subject.blocks.filter((b) => !b.item && b.type !== 'paragraphe' && (b.text[ctx.lang] ?? '') !== '').map((b) => b.zone));
  const items = new Set(ctx.subject.blocks.filter((b) => b.item && (b.text[ctx.lang] ?? '') !== '').map((b) => b.item!));
  const titled = new Set(elementsOf(ctx.template).filter((z) => z.type === 'titre' || z.type === 'bandeau').map((z) => z.id));
  const texts = Object.fromEntries(Object.entries(filler.texts).map(([zone, text]) => [zone, titled.has(zone) || zones.has(zone) ? (real.texts[zone] ?? '') : text]));
  const fiche = Object.fromEntries(Object.entries(filler.fiche).map(([item, text]) => [item, items.has(item) ? (real.fiche[item] ?? '') : text]));
  const headings = { ...(filler.headings ?? {}), ...(real.headings ?? {}) };
  // Une image déposée et lisible est montrée ; ailleurs, l'image d'essai de l'aperçu d'un modèle, sans cadrage. L'aplat « à venir » et le faux
  // QR « absent » de l'aperçu d'un sujet portent un texte hors du pack (C7, C8) ; le vrai QR, lui, est montré tel quel.
  const placeholder = placeholderImage();
  const images: Record<string, string> = {};
  const placements: NonNullable<RenderContent['placements']> = {};
  for (const [zone, image] of Object.entries(filler.images)) {
    const deposited = real.images[zone] !== undefined && real.images[zone] !== placeholder;
    images[zone] = deposited ? real.images[zone]! : image;
    if (deposited && real.placements?.[zone]) placements[zone] = real.placements[zone];
  }
  return { ...real, texts, fiche, images, placements, headings, chains: subjectChains(ctx, filler.chains), qrSvg: ctx.qr ? ctx.qr.svg : filler.qrSvg };
}

/** Le HTML d'un sujet avec les coupures données ; sans coupure, le HTML final d'un sujet sans chaîne. */
export function subjectBuilder(ctx: SubjectContext): { build: HtmlBuilder; content: RenderContent } {
  const content = subjectContent(ctx);
  return { content, build: (cuts) => renderHtml(ctx.layout, ctx.trim, ctx.collection.style, cuts ? { ...content, cuts } : content, ctx.collection.pictos) };
}

/** Sans chaîne seulement : le HTML final. Avec une chaîne, `subjectPage`. */
export const subjectHtml = (ctx: SubjectContext) => subjectBuilder(ctx).build();

/** Le HTML final de l'aperçu d'un sujet : le texte des chaînes coupé dans Chromium (ED2). */
export function subjectPage(ctx: SubjectContext): Promise<Flowed> {
  const { build, content } = subjectBuilder(ctx);
  return flowHtml(build, content.chains ?? {});
}

/** Ce que les données seules disent (aucun Chromium) : C5, C9 hors capture, C10, C11, C13, C16 et C17 en erreur, une ligne par faute. */
export function readyErrors(ctx: SubjectContext, research: StoredResearch | null, miseEnPage: string[]): string[] {
  const { zones, checks } = imageChecks(ctx);
  const lines = (list: CheckResult[]) => list.filter((c) => c.level === 'erreur').flatMap((c) => c.details.map((d) => `${c.id}, ${d}`));
  const data = runSubjectChecks({ ...contentInput(ctx, research), measures: { overflows: [] } });
  return [
    ...zones.flatMap((z) => (z.fault ? [`C5, ${z.fault}`] : [])),
    ...lines(checks),
    ...lines(data.filter((c) => c.id === 'C10' || c.id === 'C13')),
    ...miseEnPage,
    ...qrDataFaults(qrInput(ctx)).map((d) => `C9, ${d}`),
  ];
}

const qrInput = (ctx: SubjectContext) => ({
  sceneId: ctx.subject.sceneId ?? null,
  expectedFile: ctx.qrExpectedFile,
  qr: ctx.qr ? { file: ctx.qr.file, url: ctx.qr.url } : null,
  fault: ctx.qrFault,
  expectedUrl: ctx.qrExpectedUrl,
});

function contentInput(ctx: SubjectContext, research: StoredResearch | null, chains?: Parameters<typeof runSubjectChecks>[0]['chains'], measures?: Measures) {
  return {
    blocks: ctx.subject.blocks,
    expected: ctx.expected,
    lang: ctx.lang,
    title: ctx.title,
    titleMax: zoneLimit(ctx.template, 'titre'),
    legend: ctx.legend,
    legendMax: zoneLimit(ctx.template, 'qr'),
    claims: research?.claims ?? [],
    measures: measures ?? { overflows: [] },
    essaiPhrases: PLACEHOLDER_PHRASES,
    essaiValues: PLACEHOLDER_FICHE_VALUES,
    ...(chains ? { chains } : {}),
  };
}

/**
 * Tous les contrôles d'un sujet, sur son vrai contenu : C10, C12 et C13 viennent des données et de Chromium, C3, C4, C6, C7 et C8 du PDF du
 * sujet, C9 du cartouche du QR capturé puis décodé, C17 de la géométrie. « Relu » ne demande que C10, C12 et C13 ; « prêt » demande tout.
 */
export async function controlSubject(ctx: SubjectContext, research: StoredResearch | null): Promise<CheckResult[]> {
  const { build, content } = subjectBuilder(ctx);
  const texts = content.chains ?? {};
  const { pdf, measures, flow } = await renderFlowedPdf(build, texts, ctx.trim);
  const facts = await readPdfFacts(pdf);
  const subjectChecks = runSubjectChecks(contentInput(ctx, research, { defs: chainsOf(ctx.template), texts, flow }, measures));
  const capture = ctx.qr ? await captureQr(build, texts) : null;
  const decoded = capture ? await decodeQr(capture.png) : null;
  const c9 = c9Qr({ ...qrInput(ctx), capture: capture && { sideMm: capture.sideMm }, decoded });
  return [...subjectChecks, ...imageChecks(ctx).checks, ...pdfChecks({ facts, measures, pages: ctx.layout }), c9, c17Overlaps(ctx.layout)];
}
