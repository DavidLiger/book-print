// src/server/subject-actions.ts — sujets, recherche, relecture, contrôles (spec §5.2, étapes 2 à 5 et 7). `dir` est le dossier du livre dans
// GLBInterpreter : chaque action relit le livre, pour le titre de la scène et son `bookId`. Le serveur est le seul à sortir, et seulement dans
// `/api/sujet/urls`, sur action de David.
import { z } from 'zod';
import { readCollection } from '../data/collection';
import { changeModel, createSubject, deleteSubject, firstPageOf, keepDatedCopies, readResearch, readSubject, SubjectRefused, updateSubject } from '../data/subject-file';
import { readPrintBook } from '../data/pricing-file';
import { readBook, type BookReading } from '../glbi/read';
import { urlIsDead } from '../checks/content';
import { duplicateFault, zoneLimit } from '../research/blocks';
import { ResearchRefused } from '../research/errors';
import { checkAgainst, mergeImport, parseResearch } from '../research/import';
import { researchPrompt } from '../research/prompt';
import { applyBlockAction, applyClaimAction, touched } from '../research/state';
import { checkUrls, defaultUrlDeps, type UrlDeps } from '../research/url-check';
import { applyBookFiche, RenderRefused } from '../render/html';
import { controlSubject, subjectContext, subjectPage, type QrSource, type SubjectContext } from '../render/subject';
import { computeParcours, isValidated } from '../parcours/steps';
import { readFacts, subjectLayoutFacts } from '../parcours/facts';
import { reviewState } from '../schema/block';
import { slugSchema } from '../schema/common';
import type { StoredResearch } from '../schema/research';
import { templateFits } from '../templates';
import { readTemplates, validTemplates } from '../templates/files';
import { sameFormat } from '../layout/model';
import type { Config } from './config';

export class BadSubjectRequest extends Error {}

/** Un `research.json` dépasse les 64 Kio des autres routes : limite propre à l'import. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

type Json = Record<string, unknown>;

const dirBody = z.strictObject({ dir: z.string() });
const subjectBody = z.strictObject({ dir: z.string(), subjectId: slugSchema });
const createBody = z.strictObject({ dir: z.string(), sceneId: z.string(), pages: z.number().int().min(2), template: z.string(), theme: slugSchema });
const importBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, content: z.string(), confirm: z.boolean().optional() });
const claimBody = z.strictObject({
  dir: z.string(),
  subjectId: slugSchema,
  claimId: slugSchema,
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('valider') }),
    z.strictObject({ kind: z.literal('rejeter') }),
    z.strictObject({ kind: z.literal('corriger'), text: z.string() }),
    z.strictObject({ kind: z.literal('note'), text: z.string().max(2000) }),
  ]),
});
const blockBody = z.strictObject({
  dir: z.string(),
  subjectId: slugSchema,
  blockId: slugSchema,
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('valider') }),
    z.strictObject({ kind: z.literal('texte'), text: z.string() }),
    z.strictObject({ kind: z.literal('citer'), claims: z.array(slugSchema) }),
    z.strictObject({ kind: z.literal('entete'), text: z.string() }),
    z.strictObject({ kind: z.literal('valider-entete') }),
  ]),
});
/** `title` nul : retire la surcharge, le titre revient à celui de la scène. */
const fieldsBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, title: z.string().nullable().optional(), legend: z.string().optional(), theme: slugSchema.optional() });
const checkBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, mark: z.boolean().optional() });
const deleteBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, confirm: z.literal(true) });
const modelBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, modelId: z.string() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadSubjectRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

export function reading(config: Config, dir: string): BookReading & { bookId: string } {
  const read = readBook(config.glbRoot, dir);
  if (read.errors.length > 0 || !read.bookId) throw new SubjectRefused(`Lecture de GLBInterpreter en erreur : ${read.errors.join(' ; ')}`);
  return { ...read, bookId: read.bookId };
}

/** Où lire le QR réel du livre : `dist/qr/<bookId>/` de GLBInterpreter, sous l'origine de `book.json` (ED6). */
export const qrSourceOf = (config: Config, read: BookReading): QrSource => ({ glbRoot: config.glbRoot, origin: read.origin });

function bookState(config: Config, dir: string): Json {
  const read = reading(config, dir);
  const { book, error } = readPrintBook(config.dataRoot, read.bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${read.bookId}/.`);
  const collection = readCollection(config.dataRoot);
  if (!collection) throw new SubjectRefused('collection/ absent : le créer d\'abord dans la page.');
  const subjects = book.subjects.map((id) => readSubject(config.dataRoot, read.bookId, id));
  const used = new Set(subjects.map((s) => s.sceneId));
  const firstPage = firstPageOf(config.dataRoot, book, '');
  const { rotation } = collection.style.variants;
  const last = subjects[subjects.length - 1]?.variant.theme;
  return {
    bookId: read.bookId,
    lang: book.edition.lang,
    scenes: read.scenes.map((s) => ({ id: s.id, title: s.title?.[book.edition.lang] ?? s.id, used: used.has(s.id) })),
    // Seules les mises en page du format du livre sont proposées (ED1).
    templates: Object.values(validTemplates(readTemplates(config.dataRoot, collection.style))).filter((t) => sameFormat(t, book.edition.trim)).map((t) => ({ id: t.id, pages: t.pages, fits: templateFits(t, firstPage) })),
    firstPage,
    themes: Object.keys(collection.style.palette.themes),
    /** Le thème suivant dans la rotation : deux sujets voisins ne se ressemblent pas. */
    proposedTheme: last === undefined ? rotation[0] : rotation[(rotation.indexOf(last) + 1) % rotation.length],
    subjectPages: subjects.reduce((sum, s) => sum + s.pages, 0),
    pageBudget: book.pageBudget,
  };
}

function subjectState(config: Config, dir: string, subjectId: string): Json {
  const read = reading(config, dir);
  const ctx = subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
  const research = readResearch(config.dataRoot, read.bookId, subjectId);
  const claims = research?.claims.map((c) => ({ ...c, sources: c.sources.map((s) => ({ ...s, urlDead: urlIsDead(s.urlCheck) })) })) ?? [];
  return {
    subject: ctx.subject,
    claims,
    generatedAt: research?.generatedAt ?? null,
    expected: ctx.expected,
    lang: ctx.lang,
    title: ctx.title,
    sceneTitle: ctx.sceneTitle,
    titleOverride: ctx.subject.title[ctx.lang] ?? null,
    titleMax: zoneLimit(ctx.template, 'titre'),
    legend: ctx.legend,
    legendMax: zoneLimit(ctx.template, 'qr'),
    layout: ctx.layout,
    firstPage: ctx.firstPage,
    themes: Object.keys(ctx.collection.style.palette.themes),
  };
}

function promptFor(config: Config, dir: string, subjectId: string, today: Date): string {
  const read = reading(config, dir);
  const ctx = subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
  // Deux blocs au même identifiant ne se distingueraient pas dans le fichier rendu (ED4).
  const dup = duplicateFault(ctx.expected);
  if (dup) throw new ResearchRefused(dup);
  return researchPrompt({
    subjectId,
    subjectTitle: ctx.title,
    bookTitle: read.title?.[ctx.lang] ?? read.bookId,
    lang: ctx.lang,
    templateId: ctx.template.id,
    pages: ctx.template.pages,
    blocks: ctx.expected,
    today: today.toISOString().slice(0, 10),
  });
}

function importFile(config: Config, value: z.infer<typeof importBody>): Json {
  const { dir, subjectId, content, confirm } = value;
  const read = reading(config, dir);
  const ctx = subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
  const file = parseResearch(content);
  checkAgainst(file, subjectId, ctx.lang, ctx.expected);
  const previous = readResearch(config.dataRoot, read.bookId, subjectId);
  const merged = mergeImport(file, previous, ctx.subject, ctx.expected);
  if (previous && !confirm) return { needsConfirm: true, summary: merged.summary, same: merged.same };
  const kept = previous ? keepDatedCopies(config.dataRoot, read.bookId, subjectId, new Date()) : [];
  updateSubject(config.dataRoot, read.bookId, subjectId, () => ({ subject: merged.subject, research: merged.research }));
  return { imported: true, summary: merged.summary, kept };
}

function requireResearch(research: StoredResearch | null): StoredResearch {
  if (!research) throw new ResearchRefused('Importer d\'abord la recherche.');
  return research;
}

function changeFields(config: Config, value: z.infer<typeof fieldsBody>): Json {
  const { dir, subjectId, title, legend, theme } = value;
  const read = reading(config, dir);
  const { book, error } = readPrintBook(config.dataRoot, read.bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${read.bookId}/.`);
  const lang = book.edition.lang;
  const themes = Object.keys(readCollection(config.dataRoot)?.style.palette.themes ?? {});
  if (theme !== undefined && !themes.includes(theme)) throw new SubjectRefused(`Thème inconnu : ${theme}.`);
  updateSubject(config.dataRoot, read.bookId, subjectId, ({ subject, research }) => {
    const next = structuredClone(subject);
    if (title === null || title?.trim() === '') delete next.title[lang];
    else if (title !== undefined) next.title[lang] = title.trim();
    if (legend !== undefined) {
      if (legend.trim() === '') throw new SubjectRefused('Légende du QR vide.');
      next.qrLegend = { ...next.qrLegend, [lang]: legend.trim() };
    }
    if (theme !== undefined) next.variant.theme = theme;
    return { subject: JSON.stringify(next) === JSON.stringify(subject) ? subject : touched(next), research };
  });
  return subjectState(config, dir, subjectId);
}

function changeClaim(config: Config, value: z.infer<typeof claimBody>, now: Date): Json {
  const { dir, subjectId, claimId, action } = value;
  const { bookId } = reading(config, dir);
  updateSubject(config.dataRoot, bookId, subjectId, ({ subject, research }) => applyClaimAction({ subject, research: requireResearch(research) }, claimId, action, now));
  return subjectState(config, dir, subjectId);
}

function changeBlock(config: Config, value: z.infer<typeof blockBody>): Json {
  const { dir, subjectId, blockId, action } = value;
  const { bookId } = reading(config, dir);
  updateSubject(config.dataRoot, bookId, subjectId, ({ subject, research }) => applyBlockAction({ subject, research: requireResearch(research) }, blockId, action));
  return subjectState(config, dir, subjectId);
}

/** Les requêtes durent : le fichier est relu après, seuls les `urlCheck` y sont posés. Une relecture faite pendant le contrôle n'est pas perdue. */
export async function checkSubjectUrls(config: Config, dir: string, subjectId: string, deps: UrlDeps): Promise<Json> {
  const { bookId } = reading(config, dir);
  const research = requireResearch(readResearch(config.dataRoot, bookId, subjectId));
  const results = await checkUrls(research.claims.flatMap((c) => c.sources.map((s) => s.url)), deps);
  updateSubject(config.dataRoot, bookId, subjectId, (data) => {
    for (const claim of requireResearch(data.research).claims) {
      for (const source of claim.sources) {
        const result = results.get(source.url);
        if (result) source.urlCheck = result;
      }
    }
    return data;
  });
  return subjectState(config, dir, subjectId);
}

let controlling = false;

/** Contrôles qui font un sujet « relu ». */
const READ_CHECKS = ['C10', 'C12', 'C13'];
/** Contrôles sans erreur pour un sujet « prêt » (ED6). */
export const READY_CHECKS = ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C17'];
const READY_STEPS = ['sujet-mise-en-page', 'sujet-recherche', 'sujet-relecture', 'sujet-illustrations', 'sujet-apercu'];

/** Chromium ne se lance qu'ici : `relu` exige tous les blocs valides, et C10, C12 et C13 sans erreur. */
async function control(config: Config, dir: string, subjectId: string, mark: boolean): Promise<Json> {
  if (controlling) throw new RenderRefused('Un contrôle est déjà en cours.');
  controlling = true;
  try {
    const read = reading(config, dir);
    const ctx: SubjectContext = subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
    const checks = await controlSubject(ctx, readResearch(config.dataRoot, read.bookId, subjectId));
    // « Relu » ne demande que le contenu : C10, C12 et C13. Les contrôles du rendu, du QR et des images sont ceux de « prêt ».
    const refused = checks.filter((c) => c.level === 'erreur' && READ_CHECKS.includes(c.id)).map((c) => c.id);
    // Un bloc n'est relu que si son texte et son en-tête le sont (ED4).
    const notValid = ctx.subject.blocks.filter((b) => reviewState(b) !== 'valide').length;
    const reason = refused.length > 0 ? `${refused.join(', ')} en erreur.` : ctx.subject.blocks.length === 0 || notValid > 0 ? `${notValid} bloc(s) à valider dans Relecture.` : null;
    const marked = mark && reason === null;
    if (marked) updateSubject(config.dataRoot, read.bookId, subjectId, (data) => ({ ...data, subject: { ...data.subject, status: 'relu' } }));
    return { checks, marked, reason, ...subjectState(config, dir, subjectId) };
  } finally {
    controlling = false;
  }
}


/** Pourquoi un sujet ne peut pas être marqué « prêt » : ses étapes d'abord, ses contrôles ensuite, chacun nommé. `null` : rien ne l'empêche. */
function notReadyReason(config: Config, dir: string, subjectId: string, checks: { id: string; level: string; details: string[] }[] | null): string | null {
  const state = loadedState(config);
  const parcours = computeParcours(readFacts(state, dir)).subjects.find((s) => s.id === subjectId);
  if (!parcours) throw new SubjectRefused(`Le sujet ${subjectId} ne figure pas dans le livre.`);
  if (parcours.status !== 'relu' && parcours.status !== 'prêt') return 'Le sujet doit d\'abord être marqué relu.';
  const open = parcours.steps.filter((st) => READY_STEPS.includes(st.id) && !isValidated(st.state));
  if (open.length > 0) return `Étapes à valider d'abord : ${open.map((st) => st.label).join(', ')}.`;
  if (checks === null) return null;
  return checksRefusal(checks);
}

/** Les contrôles de « prêt » en erreur, chacun nommé avec sa première cause ; `null` : aucun. Une alerte ne bloque pas. */
export function checksRefusal(checks: { id: string; level: string; details: string[] }[]): string | null {
  const errors = checks.filter((c) => c.level === 'erreur' && READY_CHECKS.includes(c.id));
  return errors.length > 0 ? `Contrôles en erreur : ${errors.map((c) => `${c.id}${c.details[0] ? ` (${c.details[0]}${c.details.length > 1 ? `, +${c.details.length - 1}` : ''})` : ''}`).join(' ; ')}.` : null;
}

const loadedState = (config: Config) => ({ ok: true as const, config });

/** « Marquer prêt » : les étapes du sujet validées, puis tous les contrôles, Chromium compris, sans erreur. Une alerte ne bloque pas. */
async function markReady(config: Config, dir: string, subjectId: string): Promise<Json> {
  if (controlling) throw new RenderRefused('Un contrôle est déjà en cours.');
  controlling = true;
  try {
    const early = notReadyReason(config, dir, subjectId, null);
    const read = reading(config, dir);
    if (early) return { checks: [], marked: false, reason: early, ...subjectState(config, dir, subjectId) };
    const ctx = subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
    const checks = await controlSubject(ctx, readResearch(config.dataRoot, read.bookId, subjectId));
    const reason = notReadyReason(config, dir, subjectId, checks);
    if (reason === null && ctx.subject.status !== 'prêt') updateSubject(config.dataRoot, read.bookId, subjectId, (data) => ({ ...data, subject: { ...data.subject, status: 'prêt' } }));
    return { checks, marked: reason === null, reason, ...subjectState(config, dir, subjectId) };
  } finally {
    controlling = false;
  }
}

/** « Retirer prêt » : le sujet redevient « relu ». Rien d'autre ne change. */
function unmarkReady(config: Config, dir: string, subjectId: string): Json {
  const { bookId } = reading(config, dir);
  if (readSubject(config.dataRoot, bookId, subjectId).status !== 'prêt') throw new SubjectRefused(`Le sujet ${subjectId} n'est pas marqué prêt.`);
  updateSubject(config.dataRoot, bookId, subjectId, (data) => ({ ...data, subject: { ...data.subject, status: 'relu' } }));
  return subjectState(config, dir, subjectId);
}

/** Modèles que ce sujet peut prendre : son format, ses pages, et un côté de départ qui convient (§24.12). */
function compatibleModels(config: Config, dir: string, subjectId: string): Json {
  const read = reading(config, dir);
  const { book } = readPrintBook(config.dataRoot, read.bookId);
  const collection = readCollection(config.dataRoot);
  if (!book || !collection) throw new SubjectRefused('Le livre et la collection doivent exister.');
  const subject = readSubject(config.dataRoot, read.bookId, subjectId);
  const first = firstPageOf(config.dataRoot, book, subjectId);
  const models = Object.values(validTemplates(readTemplates(config.dataRoot, collection.style)))
    .filter((t) => sameFormat(t, book.edition.trim) && t.pages === subject.pages && templateFits(t, first))
    .map((t) => ({ id: t.id, pages: t.pages }));
  return { current: subject.template, models };
}

function changeSubjectModel(config: Config, dir: string, subjectId: string, modelId: string): Json {
  const read = reading(config, dir);
  const changed = changeModel(config.dataRoot, read.bookId, subjectId, modelId, new Date());
  const { book } = readPrintBook(config.dataRoot, read.bookId);
  const gap = book ? subjectLayoutFacts(config.dataRoot, book, readSubject(config.dataRoot, read.bookId, subjectId)).blocksGap : { missing: [], extra: [] };
  return { changed, gap, ...subjectState(config, dir, subjectId) };
}

export const SUBJECT_ACTIONS: Record<string, (body: unknown, config: Config) => Json | Promise<Json>> = {
  '/api/sujets/state': (body, config) => bookState(config, parse(dirBody, body).dir),
  '/api/sujets/create': (body, config) => {
    const { dir, sceneId, pages, template, theme } = parse(createBody, body);
    const read = reading(config, dir);
    const { book } = readPrintBook(config.dataRoot, read.bookId);
    const collection = readCollection(config.dataRoot);
    if (!book || !collection) throw new SubjectRefused('Le livre et la collection doivent exister avant un sujet.');
    const style = applyBookFiche(collection.style, book);
    const subject = createSubject(config.dataRoot, read.bookId, { sceneId, pages, template, theme }, read.scenes.map((s) => s.id), Object.keys(style.palette.themes));
    return { subject, ...bookState(config, dir) };
  },
  '/api/sujet/state': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return subjectState(config, dir, subjectId);
  },
  '/api/sujet/prompt': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return { prompt: promptFor(config, dir, subjectId, new Date()) };
  },
  '/api/sujet/import': (body, config) => importFile(config, parse(importBody, body)),
  '/api/sujet/claim': (body, config) => changeClaim(config, parse(claimBody, body), new Date()),
  '/api/sujet/block': (body, config) => changeBlock(config, parse(blockBody, body)),
  '/api/sujet/fields': (body, config) => changeFields(config, parse(fieldsBody, body)),
  '/api/sujet/urls': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return checkSubjectUrls(config, dir, subjectId, defaultUrlDeps());
  },
  '/api/sujet/check': (body, config) => {
    const { dir, subjectId, mark } = parse(checkBody, body);
    return control(config, dir, subjectId, mark === true);
  },
  '/api/sujet/pret': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return markReady(config, dir, subjectId);
  },
  '/api/sujet/retirer-pret': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return unmarkReady(config, dir, subjectId);
  },
  '/api/sujet/supprimer': (body, config) => {
    const { dir, subjectId } = parse(deleteBody, body);
    const read = reading(config, dir);
    const deleted = deleteSubject(config.dataRoot, read.bookId, subjectId, new Date());
    return { deleted, ...bookState(config, dir) };
  },
  '/api/sujet/modeles': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return compatibleModels(config, dir, subjectId);
  },
  '/api/sujet/modele': (body, config) => {
    const { dir, subjectId, modelId } = parse(modelBody, body);
    return changeSubjectModel(config, dir, subjectId, modelId);
  },
};

export async function subjectPreviewHtml(dir: string | null, subjectId: string | null, config: Config): Promise<string> {
  const body = parse(subjectBody, { dir, subjectId });
  const read = reading(config, body.dir);
  return (await subjectPage(subjectContext(config.dataRoot, read.bookId, body.subjectId, read.scenes, qrSourceOf(config, read)))).html;
}
