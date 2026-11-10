// src/server/layout-actions.ts — éditeur de mise en page (ED3, spec §24.8) : l'étape du livre « Mises en page » (les modèles de
// `collection/gabarits/`) et l'étape « Mise en page » d'un sujet (sa copie, `subjects/<sujetId>/layout.json`). ED1 avait l'état, l'aperçu et le
// contrôle d'un sujet, sans éditeur ; ED3 ajoute l'état d'un modèle et les écritures : `enregistrer` (avec l'empreinte lue), `nouvelle`,
// `copier` et `miroir` (modèles seulement). Une écriture n'a lieu que pour une mise en page valide au schéma et au style, et seulement si le
// fichier est encore celui qui a été lu : sinon rien n'est écrit, et la page relit le fichier. Une faute de contrôle (C16, C17…) n'empêche pas
// l'écriture : elle est dans les motifs. Une cible est un sujet (`dir`, `subjectId`, `dir` étant le dossier du livre dans GLBInterpreter) ou un
// modèle (`bookId`, `id`, `theme` facultatif).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { overlapFaults } from '../checks/overlaps';
import { c17Overlaps } from '../checks/overlaps';
import { collectionFolder, readCollection } from '../data/collection';
import { ensureDir } from '../data/create-book';
import { readPrintBook } from '../data/pricing-file';
import { firstPageOf, readSubject, readSubjectLayout, subjectFolder, SubjectRefused } from '../data/subject-file';
import { fromV1 } from '../layout/from-v1';
import { archiveV1, LAYOUT_FILE, layoutJson, LayoutConflict, layoutOf, LayoutRefused, readLayoutBytes, sha256, writeIfUnchanged } from '../layout/files';
import { mirrorLayout } from '../layout/mirror';
import { isLayout, previewFirstPage, sameFormat, formatLabel, formatOf, versionOf, type MiseEnPage } from '../layout/model';
import { LAYOUT_VERSION, layoutSchema, subjectLayoutSchema, type Layout } from '../layout/schema';
import { subjectLayoutFacts } from '../parcours/facts';
import { controlTemplate, flowedPreview, previewOf, templatePreview, type TemplatePreview } from '../render/gabarit';
import { applyBookFiche, RenderRefused } from '../render/html';
import { editorContent, subjectContext } from '../render/subject';
import { slugSchema, templatePages, TEMPLATE_ID_PATTERN } from '../schema/common';
import { gridOf, type Style } from '../schema/style';
import { readTemplates, templateOf, templateStyleFaults, TEMPLATES_DIR, type TemplateEntry } from '../templates/files';
import { GeometryRefused, type LayoutPage } from '../templates/geometry';
import type { Config } from './config';
import { requireBook } from './gabarit-actions';
import { BadSubjectRequest, reading } from './subject-actions';

type Json = Record<string, unknown>;

const templateId = z.string().regex(TEMPLATE_ID_PATTERN, 'mise en page : par exemple 4B ou 12A');
const empreinte = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte : SHA-256 en hexadécimal');
const subjectTarget = { dir: z.string(), subjectId: slugSchema };
const modelTarget = { bookId: z.string(), id: templateId, theme: slugSchema.optional() };
const saved = { empreinte: empreinte.nullable(), document: z.record(z.string(), z.unknown()) };
const subjectBody = z.strictObject(subjectTarget);
const modelBody = z.strictObject(modelTarget);
const subjectSave = z.strictObject({ ...subjectTarget, ...saved });
const modelSave = z.strictObject({ ...modelTarget, ...saved });
const newBody = z.strictObject({ bookId: z.string(), id: templateId, start: z.enum(['gauche', 'droite'], { error: 'start : gauche ou droite' }), theme: slugSchema.optional() });
const copyBody = z.strictObject({ bookId: z.string(), id: templateId, nouvel: templateId, theme: slugSchema.optional() });
const mirrorBody = z.strictObject({ ...modelTarget, empreinte });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadSubjectRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

/** Une cible porte `subjectId` (un sujet) ou `bookId` (un modèle). */
const isSubjectTarget = (value: unknown) => typeof value === 'object' && value !== null && Object.hasOwn(value, 'subjectId');

/** Couleurs d'encadré, pictogrammes et thèmes du style : les choix des propriétés de l'éditeur. */
function optionsOf(style: Style, theme: string) {
  return { boxes: Object.keys(style.palette.boxes), pictos: Object.keys(style.pictos), themes: Object.keys(style.palette.themes), theme };
}

// Sujet

interface View {
  model: MiseEnPage;
  source: 'layout.json' | 'gabarit';
  file: string;
  modele: { id: string; empreinte: string; date: string } | null;
  errors: string[];
  preview: TemplatePreview | null;
  firstPage: number;
  /** La mise en page que l'éditeur modifie : la copie, ou la conversion du gabarit d'un sujet d'avant ED1 (rien n'est écrit à la lecture). */
  document: Layout | null;
  /** Empreinte des octets de `layout.json`, `null` s'il n'existe pas encore. */
  empreinte: string | null;
  style: Style;
  theme: string;
  /** Rapport de l'image entière d'un détouré déposé : la poignée le garde (décision de David, ED3). */
  ratios: Record<string, number>;
}

/** La mise en page du sujet et son aperçu : texte réel là où il existe, remplissage ailleurs (ED3). Pas d'aperçu tant qu'elle ne se pose pas. */
function view(config: Config, dir: string, subjectId: string): View {
  const read = reading(config, dir);
  const { bookId } = read;
  const { book, error } = readPrintBook(config.dataRoot, bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const collection = readCollection(config.dataRoot);
  if (!collection) throw new SubjectRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(collection.style, book);
  const subject = readSubject(config.dataRoot, bookId, subjectId);
  const facts = subjectLayoutFacts(config.dataRoot, book, subject);
  if (facts.templateError) throw new RenderRefused(facts.templateError);
  const copy = readSubjectLayout(config.dataRoot, bookId, subjectId);
  let model: MiseEnPage;
  if (copy) model = layoutOf(copy);
  else {
    const found = templateOf(readTemplates(config.dataRoot, style), subject.template);
    if ('error' in found) throw new RenderRefused(found.error);
    model = found.template;
  }
  const folder = subjectFolder(config.dataRoot, bookId, subjectId)!;
  const bytes = readLayoutBytes(path.join(folder, LAYOUT_FILE), `${bookId}/subjects/${subjectId}/${LAYOUT_FILE}`);
  const firstPage = firstPageOf(config.dataRoot, book, subjectId);
  const trim = book.edition.trim;
  const placeable = !facts.miseEnPage.errors.some((e) => !e.startsWith('C17'));
  let preview: TemplatePreview | null = null;
  const ratios: Record<string, number> = {};
  if (placeable) {
    const ctx = subjectContext(config.dataRoot, bookId, subjectId, read.scenes);
    preview = previewOf(ctx.layout, trim, model, ctx.collection.style, editorContent(ctx), ctx.collection.pictos);
    for (const zone of ctx.layout.flatMap((p) => p.zones)) {
      if (zone.outline && zone.double !== 'fin') ratios[zone.id] = (zone.outline.image.right - zone.outline.image.left) / (zone.outline.image.bottom - zone.outline.image.top);
    }
  }
  let document: Layout | null = copy ? layoutOf(copy) : null;
  if (!document && preview) document = isLayout(model) ? model : fromV1(model, trim, style.margins, firstPage);
  return {
    model,
    source: copy ? 'layout.json' : 'gabarit',
    file: copy ? `${bookId}/subjects/${subjectId}/${LAYOUT_FILE}` : `collection/gabarits/${subject.template}.json`,
    modele: copy?.modele ?? null,
    errors: facts.miseEnPage.errors,
    preview,
    firstPage,
    document,
    empreinte: bytes ? sha256(bytes) : null,
    style,
    theme: subject.variant.theme,
    ratios,
  };
}

/** Coordonnées des éléments, en mm sur la page rognée : celles du document de l'éditeur. */
function rows(v: View): Json[] {
  if (!v.document) return (isLayout(v.model) ? v.model.elements : []).map((e) => ({ id: e.id, type: e.type, page: e.page }));
  return v.document.elements.map((e) => ({ id: e.id, type: e.type, page: e.page, x: e.x, y: e.y, w: e.w, h: e.h, double: e.double ?? false }));
}

function subjectState(config: Config, dir: string, subjectId: string): Json {
  const v = view(config, dir, subjectId);
  return {
    cible: 'sujet',
    source: v.source,
    file: v.file,
    // Le fichier que l'éditeur écrit : `layout.json`, même pour un sujet d'avant ED1 (premier enregistrement, MP-25).
    target: `${reading(config, dir).bookId}/subjects/${subjectId}/${LAYOUT_FILE}`,
    modele: v.modele,
    version: isLayout(v.model) ? 2 : 1,
    id: v.model.id,
    pages: v.model.pages,
    start: v.model.start,
    firstPage: v.firstPage,
    errors: v.errors,
    elements: rows(v),
    layout: v.preview?.layout ?? null,
    document: v.document,
    empreinte: v.empreinte,
    grille: gridOf(v.style),
    options: optionsOf(v.style, v.theme),
    ratios: v.ratios,
  };
}

/** Le document envoyé par l'éditeur, validé : schéma, identifiant, nombre de pages, format, couleurs et pictogrammes du style. */
function checkDocument(document: Record<string, unknown>, expect: { id: string; pages: number; trim: { widthIn: number; heightIn: number } }, style: Style): Layout {
  const { modele: _modele, ...rest } = document;
  const parsed = layoutSchema.safeParse(rest);
  if (!parsed.success) throw new LayoutRefused(`Refusé, rien n'est écrit : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}`);
  const layout = parsed.data;
  if (layout.id !== expect.id) throw new LayoutRefused(`Refusé, rien n'est écrit : identifiant ${layout.id}, ${expect.id} attendu.`);
  if (layout.pages !== expect.pages) throw new LayoutRefused(`Refusé, rien n'est écrit : ${layout.pages} pages, ${expect.pages} attendues.`);
  if (layout.trim.widthIn !== expect.trim.widthIn || layout.trim.heightIn !== expect.trim.heightIn) throw new LayoutRefused(`Refusé, rien n'est écrit : format ${formatLabel(layout.trim)}, le livre est en ${formatLabel(expect.trim)}.`);
  const faults = templateStyleFaults(layout, style);
  if (faults.length) throw new LayoutRefused(`Refusé, rien n'est écrit : ${faults.join(' ; ')}`);
  return layout;
}

function saveSubject(config: Config, body: z.infer<typeof subjectSave>, now: Date): Json {
  const { bookId } = reading(config, body.dir);
  const { book, error } = readPrintBook(config.dataRoot, bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const collection = readCollection(config.dataRoot);
  if (!collection) throw new SubjectRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(collection.style, book);
  const subject = readSubject(config.dataRoot, bookId, body.subjectId);
  const folder = subjectFolder(config.dataRoot, bookId, body.subjectId)!;
  const label = `${bookId}/subjects/${body.subjectId}/${LAYOUT_FILE}`;
  const bytes = readLayoutBytes(path.join(folder, LAYOUT_FILE), label);
  if (body.empreinte === null ? bytes !== null : bytes === null || sha256(bytes) !== body.empreinte) {
    throw new LayoutConflict(`${label} a changé depuis sa lecture : il est relu, l'historique d'annulation repart de zéro.`);
  }
  // L'origine reste celle de la copie ; pour un sujet d'avant ED1, son gabarit, lu maintenant (premier enregistrement, ED3).
  let modele: { id: string; empreinte: string; date: string };
  if (bytes) modele = readSubjectLayout(config.dataRoot, bookId, body.subjectId)!.modele;
  else {
    const found = templateOf(readTemplates(config.dataRoot, style), subject.template);
    if ('error' in found) throw new RenderRefused(found.error);
    modele = { id: subject.template, empreinte: found.sha256, date: now.toISOString() };
  }
  const id = bytes ? readSubjectLayout(config.dataRoot, bookId, body.subjectId)!.id : subject.template;
  const layout = checkDocument(body.document, { id, pages: subject.pages, trim: book.edition.trim }, style);
  const file = subjectLayoutSchema.parse({ ...layout, modele });
  const content = layoutJson(file);
  if (!bytes || bytes.toString('utf8') !== content) writeIfUnchanged(folder, LAYOUT_FILE, content, body.empreinte, label);
  return subjectState(config, body.dir, body.subjectId);
}

// Modèle

interface ModelContext {
  bookId: string;
  style: Style;
  entry: TemplateEntry;
  template: MiseEnPage;
  trim: { widthIn: number; heightIn: number };
  firstPage: number;
  dir: string;
}

function library(dataRoot: string, bookId: string) {
  const book = requireBook(dataRoot, bookId);
  const collection = readCollection(dataRoot);
  if (!collection) throw new RenderRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(collection.style, book);
  const read = readTemplates(dataRoot, style);
  if (read.error) throw new RenderRefused(read.error);
  return { book, style, read };
}

/** Le modèle `id`, lu, valide et au format du livre. Un modèle invalide ou d'un autre format n'est pas ouvert dans l'éditeur. */
function modelContext(dataRoot: string, bookId: string, id: string): ModelContext {
  const { book, style, read } = library(dataRoot, bookId);
  const entry = read.entries.find((e) => e.id === id);
  if (!entry) throw new RenderRefused(`Mise en page ${id} absente de collection/${TEMPLATES_DIR}/.`);
  if (!entry.template) throw new RenderRefused(`Mise en page ${id} invalide : ${entry.error}`);
  const format = formatOf(entry.template);
  if (format && !sameFormat(entry.template, book.edition.trim)) throw new RenderRefused(`Mise en page ${id} faite pour ${formatLabel(format)} : le livre est en ${formatLabel(book.edition.trim)}.`);
  return { bookId, style, entry, template: entry.template, trim: book.edition.trim, firstPage: previewFirstPage(entry.template), dir: path.join(collectionFolder(dataRoot)!, TEMPLATES_DIR) };
}

/** Le document de l'éditeur : la version 2 telle quelle, ou la conversion d'une version 1 au format du livre et aux marges du style. */
function modelDocument(mc: ModelContext): Layout {
  return isLayout(mc.template) ? mc.template : fromV1(mc.template, mc.trim, mc.style.margins, mc.firstPage);
}

function modelState(dataRoot: string, bookId: string, id: string, theme?: string): Json {
  const mc = modelContext(dataRoot, bookId, id);
  const errors: string[] = [];
  let document: Layout | null = null;
  let geometry: LayoutPage[] | null = null;
  try {
    document = modelDocument(mc);
  } catch (e) {
    if (!(e instanceof GeometryRefused)) throw e;
    errors.push(e.message);
  }
  const chosen = theme ?? mc.style.variants.rotation[0]!;
  try {
    geometry = templatePreview(dataRoot, bookId, id, chosen).layout;
    errors.push(...overlapFaults(geometry).map((d) => `C17, ${d}`));
  } catch (e) {
    if (!(e instanceof GeometryRefused) && !(e instanceof RenderRefused)) throw e;
    errors.push(e.message);
  }
  const book = requireBook(dataRoot, bookId);
  const subjects: string[] = [];
  for (const sid of book.subjects) {
    try {
      if (readSubject(dataRoot, bookId, sid).template === id) subjects.push(sid);
    } catch (e) {
      if (!(e instanceof SubjectRefused)) throw e;
    }
  }
  return {
    cible: 'modele',
    id,
    file: mc.entry.file,
    target: mc.entry.file,
    empreinte: mc.entry.sha256,
    version: versionOf(mc.template),
    pages: mc.template.pages,
    start: mc.template.start,
    firstPage: mc.firstPage,
    errors,
    layout: geometry,
    document,
    grille: gridOf(mc.style),
    options: optionsOf(mc.style, chosen),
    subjects,
    ratios: {},
  };
}

/**
 * Écrit un modèle valide, seulement si le fichier est encore celui qui a été lu. Au premier enregistrement d'une version 1, le fichier lu est
 * d'abord gardé dans `archives/`. Rien n'est écrit si le contenu ne change pas.
 */
function writeModel(mc: ModelContext, layout: Layout, expected: string | null, now: Date): void {
  const name = `${mc.entry.id}.json`;
  const label = `collection/${TEMPLATES_DIR}/${name}`;
  const bytes = readLayoutBytes(path.join(mc.dir, name), label);
  if (!bytes || sha256(bytes) !== expected) throw new LayoutConflict(`${label} a changé depuis sa lecture : il est relu, l'historique d'annulation repart de zéro.`);
  const content = layoutJson(layout);
  if (bytes.toString('utf8') === content) return;
  if (!isLayout(mc.template)) archiveV1(mc.dir, mc.entry.id, bytes, now);
  writeIfUnchanged(mc.dir, name, content, expected, label);
}

/** Le fichier n'a pas bougé depuis sa lecture : vérifié avant toute autre lecture, pour qu'un fichier devenu invalide soit relu, pas refusé. */
function unchanged(dataRoot: string, bookId: string, id: string, expected: string | null): void {
  const { read } = library(dataRoot, bookId);
  const entry = read.entries.find((e) => e.id === id);
  if (!entry || entry.sha256 !== expected) throw new LayoutConflict(`collection/${TEMPLATES_DIR}/${id}.json a changé depuis sa lecture : il est relu, l'historique d'annulation repart de zéro.`);
}

function saveModel(dataRoot: string, body: z.infer<typeof modelSave>, now: Date): Json {
  unchanged(dataRoot, body.bookId, body.id, body.empreinte);
  const mc = modelContext(dataRoot, body.bookId, body.id);
  const layout = checkDocument(body.document, { id: mc.entry.id, pages: mc.template.pages, trim: mc.trim }, mc.style);
  writeModel(mc, layout, body.empreinte, now);
  return modelState(dataRoot, body.bookId, body.id, body.theme);
}

/** Une mise en page de la collection écrite sans écraser (`wx`) : « Nouvelle mise en page » et copie. */
function writeNewModel(dataRoot: string, layout: Layout): void {
  const root = fs.realpathSync.native(dataRoot);
  ensureDir(root, ['collection', TEMPLATES_DIR], { created: [], kept: [] });
  try {
    fs.writeFileSync(path.join(root, 'collection', TEMPLATES_DIR, `${layout.id}.json`), layoutJson(layout), { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new LayoutRefused(`collection/${TEMPLATES_DIR}/${layout.id}.json existe déjà : rien n'est écrasé.`);
    throw e;
  }
}

function validNew(value: unknown): Layout {
  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success) throw new LayoutRefused(`Refusé, rien n'est écrit : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}`);
  return parsed.data;
}

/** « Nouvelle mise en page » : vide, au format du livre ; le nombre de pages est celui de l'identifiant (4B : 4 pages). */
function newModel(dataRoot: string, body: z.infer<typeof newBody>): Json {
  const { book } = library(dataRoot, body.bookId);
  const trim = { widthIn: book.edition.trim.widthIn, heightIn: book.edition.trim.heightIn };
  writeNewModel(dataRoot, validNew({ schemaVersion: LAYOUT_VERSION, id: body.id, pages: templatePages(body.id), start: body.start, trim, elements: [] }));
  return modelState(dataRoot, body.bookId, body.id, body.theme);
}

/** Copie d'un modèle sous un nouvel identifiant, du même nombre de pages ; une version 1 est copiée convertie. */
function copyModel(dataRoot: string, body: z.infer<typeof copyBody>): Json {
  const mc = modelContext(dataRoot, body.bookId, body.id);
  let source: Layout;
  try {
    source = modelDocument(mc);
  } catch (e) {
    if (e instanceof GeometryRefused) throw new LayoutRefused(e.message);
    throw e;
  }
  writeNewModel(dataRoot, validNew({ ...structuredClone(source), id: body.nouvel }));
  return modelState(dataRoot, body.bookId, body.nouvel, body.theme);
}

function mirrorModel(dataRoot: string, body: z.infer<typeof mirrorBody>, now: Date): Json {
  unchanged(dataRoot, body.bookId, body.id, body.empreinte);
  const mc = modelContext(dataRoot, body.bookId, body.id);
  let source: Layout;
  try {
    source = modelDocument(mc);
  } catch (e) {
    if (e instanceof GeometryRefused) throw new LayoutRefused(e.message);
    throw e;
  }
  const result = mirrorLayout(source);
  if ('issues' in result) throw new LayoutRefused(`Miroir refusé, rien n'est écrit : ${result.issues}`);
  writeModel(mc, result.layout, body.empreinte, now);
  return modelState(dataRoot, body.bookId, body.id, body.theme);
}

let controlling = false;

export const LAYOUT_ACTIONS: Record<string, (body: unknown, config: Config) => Json | Promise<Json>> = {
  '/api/mise-en-page/state': (body, config) => {
    if (isSubjectTarget(body)) {
      const { dir, subjectId } = parse(subjectBody, body);
      return subjectState(config, dir, subjectId);
    }
    const { bookId, id, theme } = parse(modelBody, body);
    return modelState(config.dataRoot, bookId, id, theme);
  },
  '/api/mise-en-page/controle': async (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    const v = view(config, dir, subjectId);
    if (!v.preview) throw new RenderRefused(v.errors.join(' '));
    if (controlling) throw new RenderRefused('Un contrôle de mise en page est déjà en cours.');
    controlling = true;
    try {
      const checks = await controlTemplate(v.preview);
      return { checks: checks.some((c) => c.id === 'C17') ? checks : [...checks, c17Overlaps(v.preview.layout)] };
    } finally {
      controlling = false;
    }
  },
  '/api/mise-en-page/enregistrer': (body, config) => {
    if (isSubjectTarget(body)) return saveSubject(config, parse(subjectSave, body), new Date());
    return saveModel(config.dataRoot, parse(modelSave, body), new Date());
  },
  '/api/mise-en-page/nouvelle': (body, config) => newModel(config.dataRoot, parse(newBody, body)),
  '/api/mise-en-page/copier': (body, config) => copyModel(config.dataRoot, parse(copyBody, body)),
  '/api/mise-en-page/miroir': (body, config) => mirrorModel(config.dataRoot, parse(mirrorBody, body), new Date()),
};

export async function layoutPreviewHtml(dir: string | null, subjectId: string | null, config: Config): Promise<string> {
  const body = parse(subjectBody, { dir, subjectId });
  const v = view(config, body.dir, body.subjectId);
  if (!v.preview) throw new RenderRefused(v.errors.join(' '));
  return (await flowedPreview(v.preview)).html;
}
