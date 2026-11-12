// src/data/subject-file.ts — `<bookId>/subjects/<sujetId>/subject.json` et `research.json`, et la liste `subjects` de `print-book.json`.
// Mêmes garanties que `pricing-file.ts` : fichier temporaire, `fsync`, renommage ; refus de tout lien ou jonction ; un fichier existant et
// invalide n'est jamais écrasé. Un second import garde les anciens fichiers sous un nom daté. Rien n'est écrit hors de `dataRoot`.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isInside } from '../glbi/paths';
import { glbiIdSchema, slugSchema, WINDOWS_RESERVED } from '../schema/common';
import { printBookSchema, type PrintBook } from '../schema/print-book';
import { storedResearchSchema, type StoredResearch } from '../schema/research';
import { subjectSchema, type Subject } from '../schema/subject';
import { copyModel, fileStamp, LAYOUT_FILE } from '../layout/files';
import { formatLabel, formatOf, sameFormat } from '../layout/model';
import { subjectLayoutSchema, type SubjectLayout } from '../layout/schema';
import { FIRST_SUBJECT_PAGE, templateFits } from '../templates';
import { GeometryRefused } from '../templates/geometry';
import { readTemplates, templateOf } from '../templates/files';
import { readCollection } from './collection';
import { writeAtomic } from './atomic';
import { illustrationFolder } from './illustration-file';
import { bookFolder } from './pricing-file';

export class SubjectRefused extends Error {}

export const SUBJECT_FILE = 'subject.json';
export const RESEARCH_FILE = 'research.json';

/** Phrase générique, modifiable dans Relecture : aucun sujet n'y est nommé. */
export const QR_LEGEND_DEFAULT = { fr: 'Scanne-moi pour le voir en 3D', en: 'Scan me to see it in 3D', es: 'Escanéame para verlo en 3D' } as const;

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** `sceneId` admet majuscules et `_`, pas l'identifiant d'un sujet. */
export function subjectIdFor(sceneId: string): string {
  const parsed = glbiIdSchema.safeParse(sceneId);
  if (!parsed.success) throw new SubjectRefused(`Scène refusée : ${sceneId}.`);
  const id = sceneId.toLowerCase().replace(/_/g, '-').replace(/-+/g, '-').replace(/-$/, '');
  if (!slugSchema.safeParse(id).success) throw new SubjectRefused(`La scène ${sceneId} ne donne pas d'identifiant de sujet valide.`);
  if (WINDOWS_RESERVED.test(id)) throw new SubjectRefused(`La scène ${sceneId} donne ${id}, un nom réservé par Windows.`);
  return id;
}

function realDir(dir: string, label: string, root: string): string | null {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SubjectRefused(`${label} n'est pas un dossier réel : rien n'est lu ni écrit.`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new SubjectRefused(`${label} sort de dataRoot : rien n'est lu ni écrit.`);
  return dir;
}

function subjectsDir(dataRoot: string, bookId: string): string | null {
  const book = bookFolder(dataRoot, bookId);
  if (!book) return null;
  return realDir(path.join(book, 'subjects'), `${bookId}/subjects/`, fs.realpathSync.native(dataRoot));
}

/** Dossier réel d'un sujet, `null` s'il n'existe pas. */
export function subjectFolder(dataRoot: string, bookId: string, id: string): string | null {
  if (!slugSchema.safeParse(id).success) throw new SubjectRefused(`Sujet refusé : ${id}.`);
  const dir = subjectsDir(dataRoot, bookId);
  if (!dir) return null;
  return realDir(path.join(dir, id), `${bookId}/subjects/${id}/`, fs.realpathSync.native(dataRoot));
}

function readJsonFile<T>(file: string, label: string, schema: z.ZodType<T>): T | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new SubjectRefused(`${label} n'est pas un fichier réel : rien n'est lu ni écrit.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new SubjectRefused(`${label} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SubjectRefused(`${label} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.`);
  return parsed.data;
}

export function readSubject(dataRoot: string, bookId: string, id: string): Subject {
  const label = `${bookId}/subjects/${id}/${SUBJECT_FILE}`;
  const dir = subjectFolder(dataRoot, bookId, id);
  if (!dir) throw new SubjectRefused(`Dossier du sujet ${id} absent. Le recréer, ou retirer le sujet de print-book.json.`);
  const subject = readJsonFile(path.join(dir, SUBJECT_FILE), label, subjectSchema);
  if (!subject) throw new SubjectRefused(`${label} absent.`);
  if (subject.id !== id) throw new SubjectRefused(`${label} porte l'identifiant ${subject.id}. Le fichier est conservé tel quel.`);
  return subject;
}

/** `layout.json` du sujet (ED1) : `null` pour un sujet créé avant ED1, qui garde le gabarit de sa collection. */
export function readSubjectLayout(dataRoot: string, bookId: string, id: string): SubjectLayout | null {
  const dir = subjectFolder(dataRoot, bookId, id);
  if (!dir) return null;
  const label = `${bookId}/subjects/${id}/${LAYOUT_FILE}`;
  const layout = readJsonFile(path.join(dir, LAYOUT_FILE), label, subjectLayoutSchema);
  if (layout && layout.pages !== readSubject(dataRoot, bookId, id).pages) throw new SubjectRefused(`${label} a ${layout.pages} pages, le sujet en a ${readSubject(dataRoot, bookId, id).pages}. Le fichier est conservé tel quel.`);
  return layout;
}

export function readResearch(dataRoot: string, bookId: string, id: string): StoredResearch | null {
  const dir = subjectFolder(dataRoot, bookId, id);
  if (!dir) return null;
  const label = `${bookId}/subjects/${id}/${RESEARCH_FILE}`;
  const research = readJsonFile(path.join(dir, RESEARCH_FILE), label, storedResearchSchema);
  if (research && research.subjectId !== id) throw new SubjectRefused(`${label} porte le sujet ${research.subjectId}. Le fichier est conservé tel quel.`);
  return research;
}

/** Stricte, contrairement à `readPrintBook` : ce qui va être réécrit doit être valide. */
function requirePrintBook(dataRoot: string, bookId: string): { dir: string; book: PrintBook } {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) throw new SubjectRefused(`Dossier du livre absent : ${bookId}/. Le créer d'abord dans la page.`);
  const book = readJsonFile(path.join(dir, 'print-book.json'), `${bookId}/print-book.json`, printBookSchema);
  if (!book) throw new SubjectRefused(`${bookId}/print-book.json absent.`);
  return { dir, book };
}

/** Page réelle de la première page d'un sujet : le plan du livre n'existe pas encore, seule la somme des sujets précédents le donne. */
export function firstPageOf(dataRoot: string, book: PrintBook, id: string): number {
  const at = book.subjects.indexOf(id);
  const before = at < 0 ? book.subjects : book.subjects.slice(0, at);
  return before.reduce((page, other) => page + readSubject(dataRoot, book.bookId, other).pages, FIRST_SUBJECT_PAGE);
}

export interface NewSubject {
  sceneId: string;
  pages: number;
  template: string;
  theme: string;
}

/** `scenes` : les scènes lues dans GLBInterpreter. Le sujet d'abord, la liste du livre ensuite : une coupure laisse un dossier, jamais une entrée sans dossier. */
export function createSubject(dataRoot: string, bookId: string, input: NewSubject, scenes: string[], themes: string[], now = new Date()): Subject {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  if (!scenes.includes(input.sceneId)) throw new SubjectRefused(`Scène inconnue de GLBInterpreter : ${input.sceneId}.`);
  const id = subjectIdFor(input.sceneId);
  if (book.subjects.includes(id)) throw new SubjectRefused(`Le sujet ${id} existe déjà.`);
  for (const other of book.subjects) {
    const known = readSubject(dataRoot, bookId, other);
    if (known.sceneId !== undefined && known.sceneId === input.sceneId) throw new SubjectRefused(`La scène ${input.sceneId} a déjà son sujet : ${other}.`);
  }
  if (!themes.includes(input.theme)) throw new SubjectRefused(`Thème inconnu : ${input.theme}.`);
  // Les gabarits sont relus dans la collection (GB1) : un gabarit absent ou invalide est refusé, nommé.
  const collection = readCollection(dataRoot);
  const found = templateOf(readTemplates(dataRoot, collection?.style ?? null), input.template);
  if ('error' in found) throw new SubjectRefused(found.error);
  const { template } = found;
  const format = formatOf(template);
  if (format && !sameFormat(template, book.edition.trim)) throw new SubjectRefused(`La mise en page ${input.template} est faite pour ${formatLabel(format)} : le livre est en ${formatLabel(book.edition.trim)}.`);
  if (template.pages !== input.pages) throw new SubjectRefused(`Le gabarit ${input.template} a ${template.pages} pages, pas ${input.pages}.`);
  const firstPage = firstPageOf(dataRoot, book, id);
  if (!templateFits(template, firstPage)) throw new SubjectRefused(`Le gabarit ${input.template} ne peut pas commencer en page ${firstPage}.`);

  const root = subjectsDir(dataRoot, bookId);
  if (!root) throw new SubjectRefused(`${bookId}/subjects/ absent : relancer « Créer le dossier du livre ».`);
  const folder = path.join(root, id);
  if (fs.lstatSync(folder, { throwIfNoEntry: false })) throw new SubjectRefused(`Le dossier ${bookId}/subjects/${id}/ existe déjà, sans figurer dans print-book.json : rien n'est écrasé.`);

  const lang = book.edition.lang;
  const subject = subjectSchema.parse({
    schemaVersion: 1,
    id,
    sceneId: input.sceneId,
    title: {},
    pages: input.pages,
    template: input.template,
    variant: { mirror: false, theme: input.theme },
    blocks: [],
    qrLegend: { [lang]: QR_LEGEND_DEFAULT[lang] },
    illustrations: [],
    status: 'brouillon',
  });
  // La copie de la mise en page d'abord (ED1) : un sujet n'existe jamais sans elle. Une version 1 y est convertie, au format du livre.
  let copy;
  try {
    copy = copyModel(template, found.sha256, book.edition.trim, collection!.style.margins, firstPage, now);
  } catch (e) {
    if (e instanceof GeometryRefused) throw new SubjectRefused(e.message);
    throw e;
  }
  fs.mkdirSync(folder);
  writeAtomic(folder, LAYOUT_FILE, json(copy));
  writeAtomic(folder, SUBJECT_FILE, json(subject));
  const updated = printBookSchema.parse({ ...book, subjects: [...book.subjects, id] });
  writeAtomic(dir, 'print-book.json', json(updated));
  return subject;
}

export interface SubjectData {
  subject: Subject;
  research: StoredResearch | null;
}

function writeBoth(dir: string, before: SubjectData, after: SubjectData): void {
  const subject = subjectSchema.parse(after.subject);
  const research = after.research === null ? null : storedResearchSchema.parse(after.research);
  if (research !== null && JSON.stringify(research) !== JSON.stringify(before.research)) writeAtomic(dir, RESEARCH_FILE, json(research));
  if (JSON.stringify(subject) !== JSON.stringify(before.subject)) writeAtomic(dir, SUBJECT_FILE, json(subject));
}

/** Lit les deux fichiers, applique le changement, puis écrit. Un fichier invalide arrête tout avant la moindre écriture. */
export function updateSubject(dataRoot: string, bookId: string, id: string, change: (data: SubjectData) => SubjectData): SubjectData {
  const before = { subject: readSubject(dataRoot, bookId, id), research: readResearch(dataRoot, bookId, id) };
  const dir = subjectFolder(dataRoot, bookId, id)!;
  const after = change(structuredClone(before));
  writeBoth(dir, before, after);
  return after;
}

/** Copie datée avant un second import : `research.2026-11-06T14-05-12-123Z.json`. `COPYFILE_EXCL` n'écrase rien. */
export function keepDatedCopies(dataRoot: string, bookId: string, id: string, now: Date): string[] {
  const dir = subjectFolder(dataRoot, bookId, id);
  if (!dir) return [];
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const kept: string[] = [];
  for (const name of [RESEARCH_FILE, SUBJECT_FILE]) {
    const source = path.join(dir, name);
    if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const copy = `${name.replace(/\.json$/, '')}.${stamp}.json`;
    fs.copyFileSync(source, path.join(dir, copy), fs.constants.COPYFILE_EXCL);
    kept.push(copy);
  }
  return kept;
}

/** Style par défaut du livre (IC2, question 7), dans `print-book.json`. `null` le retire. Rien à changer : aucune écriture. */
export function setDefaultStyle(dataRoot: string, bookId: string, styleId: string | null): PrintBook {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  const { defaultStyle: _old, ...rest } = book;
  const next = printBookSchema.parse(styleId === null ? rest : { ...rest, defaultStyle: styleId });
  if (JSON.stringify(next) !== JSON.stringify(book)) writeAtomic(dir, 'print-book.json', json(next));
  return next;
}

/** Dossier des sujets supprimés : jamais lu comme un sujet, la liste d'un livre vient de `print-book.json`. */
export const DELETED_DIR = '.supprimes';

export interface DeletedSubject {
  /** Le dossier du sujet, sous `subjects/`. */
  folder: string;
  /** Les illustrations déplacées avec lui, s'il y en avait. */
  illustrations: boolean;
}

/**
 * Supprimer un sujet (ED6, §24.16) : rien n'est effacé. Le dossier du sujet va sous `subjects/.supprimes/<sujetId>.<date>/`, ses illustrations
 * (et leurs contours) dans le même dossier, sous `illustrations/` ; le sujet sort de la liste de `print-book.json`. Les entrées du registre des
 * droits restent. Le dossier d'abord, la liste ensuite : une coupure laisse une entrée sans dossier, que le parcours nomme, jamais un sujet perdu.
 */
export function deleteSubject(dataRoot: string, bookId: string, id: string, now = new Date()): DeletedSubject {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  if (!book.subjects.includes(id)) throw new SubjectRefused(`Le sujet ${id} ne figure pas dans print-book.json : rien n'est déplacé.`);
  const folder = subjectFolder(dataRoot, bookId, id);
  if (!folder) throw new SubjectRefused(`Dossier du sujet ${id} absent : rien à déplacer.`);
  const root = subjectsDir(dataRoot, bookId)!;
  const trash = path.join(root, DELETED_DIR);
  const stat = fs.lstatSync(trash, { throwIfNoEntry: false });
  if (!stat) fs.mkdirSync(trash);
  else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SubjectRefused(`${bookId}/subjects/${DELETED_DIR}/ n'est pas un dossier réel : rien n'est déplacé.`);
  const target = path.join(trash, `${id}.${fileStamp(now)}`);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new SubjectRefused(`${bookId}/subjects/${DELETED_DIR}/${path.basename(target)}/ existe déjà : rien n'est déplacé.`);
  const pictures = illustrationFolder(dataRoot, bookId, id);
  try {
    fs.renameSync(folder, target);
  } catch (e) {
    throw new SubjectRefused(`Le dossier du sujet ${id} ne peut pas être déplacé (${(e as Error).message}) : le fermer dans les autres programmes, puis recommencer.`);
  }
  if (pictures) {
    try {
      fs.renameSync(pictures, path.join(target, 'illustrations'));
    } catch (e) {
      fs.renameSync(target, folder);
      throw new SubjectRefused(`Les illustrations du sujet ${id} ne peuvent pas être déplacées (${(e as Error).message}) : rien n'a bougé.`);
    }
  }
  writeAtomic(dir, 'print-book.json', json(printBookSchema.parse({ ...book, subjects: book.subjects.filter((s) => s !== id) })));
  return { folder: `${bookId}/subjects/${DELETED_DIR}/${path.basename(target)}`, illustrations: pictures !== null };
}

export interface ChangedModel {
  /** L'ancien `layout.json`, gardé sous ce nom. */
  kept: string;
  /** Le sujet était « prêt » : il repasse à « relu ». */
  unmarked: boolean;
}

/**
 * Changer le modèle d'un sujet (ED6, §24.12) : le `layout.json` actuel est gardé sous `layout.<date>.json`, une nouvelle copie du modèle le
 * remplace. La recherche, la relecture et les images ne sont pas touchées : une image dont l'élément garde son identifiant reste posée, les
 * autres restent sur le disque, non montrées (GB1). Un sujet « prêt » repasse à « relu ». Le modèle doit avoir les pages du sujet, son format
 * et pouvoir commencer où le sujet commence.
 */
export function changeModel(dataRoot: string, bookId: string, id: string, modelId: string, now = new Date()): ChangedModel {
  const { book } = requirePrintBook(dataRoot, bookId);
  if (!book.subjects.includes(id)) throw new SubjectRefused(`Le sujet ${id} ne figure pas dans print-book.json.`);
  const subject = readSubject(dataRoot, bookId, id);
  const folder = subjectFolder(dataRoot, bookId, id)!;
  const collection = readCollection(dataRoot);
  const found = templateOf(readTemplates(dataRoot, collection?.style ?? null), modelId);
  if ('error' in found) throw new SubjectRefused(found.error);
  const { template } = found;
  const format = formatOf(template);
  if (format && !sameFormat(template, book.edition.trim)) throw new SubjectRefused(`La mise en page ${modelId} est faite pour ${formatLabel(format)} : le livre est en ${formatLabel(book.edition.trim)}.`);
  if (template.pages !== subject.pages) throw new SubjectRefused(`Le modèle ${modelId} a ${template.pages} pages, le sujet en a ${subject.pages}.`);
  const firstPage = firstPageOf(dataRoot, book, id);
  if (!templateFits(template, firstPage)) throw new SubjectRefused(`Le modèle ${modelId} ne peut pas commencer en page ${firstPage}.`);
  let copy;
  try {
    copy = copyModel(template, found.sha256, book.edition.trim, collection!.style.margins, firstPage, now);
  } catch (e) {
    if (e instanceof GeometryRefused) throw new SubjectRefused(e.message);
    throw e;
  }
  const current = path.join(folder, LAYOUT_FILE);
  const kept = `layout.${fileStamp(now)}.json`;
  if (fs.lstatSync(current, { throwIfNoEntry: false })?.isFile()) fs.copyFileSync(current, path.join(folder, kept), fs.constants.COPYFILE_EXCL);
  else throw new SubjectRefused(`${bookId}/subjects/${id}/${LAYOUT_FILE} absent : le changement de modèle suppose la copie du sujet.`);
  writeAtomic(folder, LAYOUT_FILE, json(copy));
  const unmarked = subject.status === 'prêt';
  const next = subjectSchema.parse({ ...subject, template: modelId, ...(unmarked ? { status: 'relu' } : {}) });
  if (JSON.stringify(next) !== JSON.stringify(subject)) writeAtomic(folder, SUBJECT_FILE, json(next));
  return { kept, unmarked };
}
