// src/server/book-actions.ts — étape « Livre complet » (MP6a) : le plan du livre et ses vrais numéros, « Ajouter une page » (copie d'un
// modèle de la collection), « Monter », « Descendre », « Supprimer », aperçu d'une partie à ses vrais numéros. Une page du livre s'ouvre dans
// l'éditeur par les routes de `layout-actions.ts` (cible `pageId`). Aucun PDF (MP6b).
import { z } from 'zod';
import { livreFacts } from '../book/facts';
import { NOTES_MODEL } from '../book/plan';
import { BookPageRefused, checkNewPageId, deleteBookPage, movePart, writeNewBookPage } from '../data/book-pages';
import { readCollection } from '../data/collection';
import { readPrintBook } from '../data/pricing-file';
import { readPlan, SubjectRefused } from '../data/subject-file';
import { fromV1 } from '../layout/from-v1';
import { formatLabel, formatOf, isLayout, placeMiseEnPage, sameFormat } from '../layout/model';
import { bookPageLayoutSchema, type Layout } from '../layout/schema';
import { bookPageContext, bookPageHtml } from '../render/book-page';
import { templateContent } from '../render/gabarit';
import { applyBookFiche, RenderRefused, renderHtml } from '../render/html';
import { subjectContext, subjectPage } from '../render/subject';
import { slugSchema, TEMPLATE_ID_PATTERN } from '../schema/common';
import { readTemplates, templateOf } from '../templates/files';
import { GeometryRefused, sideOfPage } from '../templates/geometry';
import type { Config } from './config';
import { BadSubjectRequest, qrSourceOf, reading } from './subject-actions';

type Json = Record<string, unknown>;

const dirBody = z.strictObject({ dir: z.string() });
const addBody = z.strictObject({ dir: z.string(), pageId: z.string(), model: z.string().regex(TEMPLATE_ID_PATTERN, 'modèle : par exemple 1A'), place: z.enum(['debut', 'fin']) });
const moveBody = z.strictObject({ dir: z.string(), id: slugSchema, sens: z.union([z.literal(-1), z.literal(1)]) });
const deleteBody = z.strictObject({ dir: z.string(), pageId: slugSchema, confirm: z.literal(true) });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadSubjectRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

const asRefusal = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof BookPageRefused) throw new SubjectRefused(e.message);
    throw e;
  }
};

function state(config: Config, dir: string): Json {
  const read = reading(config, dir);
  const { book, error } = readPrintBook(config.dataRoot, read.bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${read.bookId}/.`);
  const facts = livreFacts(config.dataRoot, read.bookId, read, config.glbRoot);
  // Les modèles proposés pour une page du livre : valides, au format du livre, de n'importe quel nombre de pages.
  const collection = readCollection(config.dataRoot);
  const library = collection ? readTemplates(config.dataRoot, applyBookFiche(collection.style, book)) : null;
  const models = (library?.entries ?? []).filter((e) => e.template && sameFormat(e.template, book.edition.trim)).map((e) => ({ id: e.id, pages: e.template!.pages, start: e.template!.start }));
  return { bookId: read.bookId, ...facts, budget: book.pageBudget, trim: book.edition.trim, models, game: read.gameQr !== null };
}

/** Nouvelle page du livre : copie du modèle (une version 1 convertie à la place où elle arrive), puis l'identifiant dans sa liste. */
function addPage(config: Config, body: z.infer<typeof addBody>, now: Date): Json {
  const read = reading(config, body.dir);
  const { book, error } = readPrintBook(config.dataRoot, read.bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${read.bookId}/.`);
  asRefusal(() => checkNewPageId(book, body.pageId));
  const collection = readCollection(config.dataRoot);
  if (!collection) throw new SubjectRefused('collection/ absent : le créer d\'abord dans la page.');
  const style = applyBookFiche(collection.style, book);
  const found = templateOf(readTemplates(config.dataRoot, style), body.model);
  if ('error' in found) throw new SubjectRefused(found.error);
  const { template } = found;
  const format = formatOf(template);
  if (format && !sameFormat(template, book.edition.trim)) throw new SubjectRefused(`La mise en page ${body.model} est faite pour ${formatLabel(format)} : le livre est en ${formatLabel(book.edition.trim)}.`);
  // Place de la page : fin des pages liminaires, ou fin du livre. Une version 1 est convertie depuis cette page ; une version 2 copiée.
  const plan = readPlan(config.dataRoot, book);
  const before = body.place === 'debut' ? plan.parts.filter((p) => p.place === 'debut') : plan.parts.filter((p) => p.kind !== 'notes');
  const firstPage = 1 + before.reduce((n, p) => n + (p.pages ?? 0), 0);
  let layout: Layout;
  try {
    layout = isLayout(template) ? structuredClone(template) : fromV1(template, book.edition.trim, style.margins, firstPage);
  } catch (e) {
    if (e instanceof GeometryRefused) throw new SubjectRefused(e.message);
    throw e;
  }
  const copy = bookPageLayoutSchema.parse({ ...layout, modele: { id: template.id, empreinte: found.sha256, date: now.toISOString() } });
  asRefusal(() => writeNewBookPage(config.dataRoot, read.bookId, body.pageId, body.place, copy));
  return state(config, body.dir);
}

export const BOOK_ACTIONS: Record<string, (body: unknown, config: Config) => Json | Promise<Json>> = {
  '/api/livre/state': (body, config) => state(config, parse(dirBody, body).dir),
  '/api/livre/ajouter': (body, config) => addPage(config, parse(addBody, body), new Date()),
  '/api/livre/deplacer': (body, config) => {
    const b = parse(moveBody, body);
    asRefusal(() => movePart(config.dataRoot, reading(config, b.dir).bookId, b.id, b.sens));
    return state(config, b.dir);
  },
  '/api/livre/supprimer': (body, config) => {
    const b = parse(deleteBody, body);
    const moved = asRefusal(() => deleteBookPage(config.dataRoot, reading(config, b.dir).bookId, b.pageId));
    return { ...state(config, b.dir), moved };
  },
};

/** Aperçu d'une partie du livre à ses vrais numéros (MP6a) : une page du livre, un sujet ou la page de notes. Même HTML que le PDF. */
export async function bookPartHtml(dir: string | null, kind: string | null, id: string | null, config: Config): Promise<string> {
  if (dir === null || id === null || !['page', 'sujet', 'notes'].includes(kind ?? '')) throw new BadSubjectRequest('dir, kind (page, sujet ou notes) et id attendus.');
  const read = reading(config, dir);
  if (kind === 'page') return bookPageHtml(bookPageContext(config.dataRoot, read.bookId, slugSchema.parse(id), read, config.glbRoot));
  if (kind === 'sujet') return (await subjectPage(subjectContext(config.dataRoot, read.bookId, slugSchema.parse(id), read.scenes, qrSourceOf(config, read)))).html;
  // La page de notes : le modèle livré 1N, posé à sa vraie page, sur le côté de cette page (le modèle est symétrique).
  const { book } = readPrintBook(config.dataRoot, read.bookId);
  if (!book) throw new RenderRefused(`Dossier du livre absent : ${read.bookId}/.`);
  const part = readPlan(config.dataRoot, book).parts.find((p) => p.kind === 'notes');
  if (!part || part.firstPage === null) throw new RenderRefused('Pas de page de notes : le total est pair.');
  const collection = readCollection(config.dataRoot);
  if (!collection) throw new RenderRefused('collection/ absent.');
  const style = applyBookFiche(collection.style, book);
  const found = templateOf(readTemplates(config.dataRoot, style), NOTES_MODEL);
  if ('error' in found || !isLayout(found.template)) throw new RenderRefused(`Page de notes : ${'error' in found ? found.error : 'version 2 attendue'}`);
  const layout = { ...found.template, start: sideOfPage(part.firstPage) };
  const pages = placeMiseEnPage(layout, book.edition.trim, style.margins, part.firstPage);
  const theme = Object.keys(style.palette.themes)[0]!;
  const filler = templateContent(layout, style.fiche, theme, book.edition.trim);
  const ctx = { layout, lang: book.edition.lang, bookTitle: '' };
  const texts = Object.fromEntries(layout.elements.filter((e) => e.type === 'titre').map((e) => [e.id, e.texteFixe?.[ctx.lang] ?? '']));
  return renderHtml(pages, book.edition.trim, style, { ...filler, title: 'Aperçu', lang: ctx.lang, texts: { ...filler.texts, ...texts } }, collection.pictos);
}

