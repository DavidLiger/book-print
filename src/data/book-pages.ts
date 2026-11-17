// src/data/book-pages.ts — pages du livre (MP6a) : pages liminaires et finales, chacune copie d'une mise en page modèle, comme un sujet :
// `<bookId>/pages/<pageId>/layout.json`, avec `modele`. `frontMatter` et `backMatter` de `print-book.json` donnent leur ordre. Ni recherche
// ni relecture. Supprimer une page la range sous `pages/.supprimes/<pageId>.<date>/`, rien n'est effacé (comme un sujet, ED6).
// Mêmes garanties que les sujets : refus de tout lien, écriture sûre, un fichier invalide n'est jamais réécrit.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isInside } from '../glbi/paths';
import { slugSchema, WINDOWS_RESERVED } from '../schema/common';
import { printBookSchema, type PrintBook } from '../schema/print-book';
import { fileStamp, LAYOUT_FILE } from '../layout/files';
import { bookPageLayoutSchema, type BookPageLayout } from '../layout/schema';
import { writeAtomic } from './atomic';
import { bookFolder } from './pricing-file';

export class BookPageRefused extends Error {}

export const PAGES_DIR = 'pages';
export const DELETED_PAGES_DIR = '.supprimes';
export type PagePlace = 'debut' | 'fin';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

function realDir(dir: string, label: string, root: string): string | null {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BookPageRefused(`${label} n'est pas un dossier réel : rien n'est lu ni écrit.`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new BookPageRefused(`${label} sort de dataRoot : rien n'est lu ni écrit.`);
  return dir;
}

/** `<bookId>/pages/`, `null` s'il n'existe pas encore. */
export function bookPagesDir(dataRoot: string, bookId: string): string | null {
  const book = bookFolder(dataRoot, bookId);
  if (!book) return null;
  return realDir(path.join(book, PAGES_DIR), `${bookId}/${PAGES_DIR}/`, fs.realpathSync.native(dataRoot));
}

/** Dossier réel d'une page du livre, `null` s'il n'existe pas. */
export function bookPageFolder(dataRoot: string, bookId: string, pageId: string): string | null {
  if (!slugSchema.safeParse(pageId).success) throw new BookPageRefused(`Page du livre refusée : ${pageId}.`);
  const dir = bookPagesDir(dataRoot, bookId);
  if (!dir) return null;
  return realDir(path.join(dir, pageId), `${bookId}/${PAGES_DIR}/${pageId}/`, fs.realpathSync.native(dataRoot));
}

export const bookPageLabel = (bookId: string, pageId: string) => `${bookId}/${PAGES_DIR}/${pageId}/${LAYOUT_FILE}`;

/** La copie d'une page du livre. Absente, illisible ou invalide : refus nommé, le fichier est gardé tel quel. */
export function readBookPage(dataRoot: string, bookId: string, pageId: string): BookPageLayout {
  const label = bookPageLabel(bookId, pageId);
  const dir = bookPageFolder(dataRoot, bookId, pageId);
  if (!dir) throw new BookPageRefused(`Dossier de la page du livre ${pageId} absent. La recréer, ou la retirer de print-book.json.`);
  const file = path.join(dir, LAYOUT_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new BookPageRefused(`${label} absent.`);
  if (!stat.isFile()) throw new BookPageRefused(`${label} n'est pas un fichier réel : rien n'est lu ni écrit.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new BookPageRefused(`${label} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.`);
  }
  const parsed = bookPageLayoutSchema.safeParse(value);
  if (!parsed.success) throw new BookPageRefused(`${label} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.`);
  return parsed.data;
}

/** Stricte : ce qui va être réécrit doit être valide. */
function requirePrintBook(dataRoot: string, bookId: string): { dir: string; book: PrintBook } {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) throw new BookPageRefused(`Dossier du livre absent : ${bookId}/. Le créer d'abord dans la page.`);
  const file = path.join(dir, 'print-book.json');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new BookPageRefused(`${bookId}/print-book.json absent.`);
  const parsed = printBookSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  if (!parsed.success) throw new BookPageRefused(`${bookId}/print-book.json invalide : ${issues(parsed.error)}.`);
  return { dir, book: parsed.data };
}

/**
 * Nouvelle page du livre : la copie (déjà faite par l'appelant, qui lit la collection) est écrite dans `pages/<pageId>/layout.json`, puis
 * l'identifiant entre dans `frontMatter` (au début du livre) ou `backMatter` (à la fin), à la fin de la liste. L'identifiant est refusé s'il
 * est déjà une page du livre ou un sujet (décision de David). La page d'abord, la liste ensuite : une coupure laisse un dossier, jamais une
 * entrée sans dossier ; ce dossier est ensuite refusé, sans écrasement.
 */
export function writeNewBookPage(dataRoot: string, bookId: string, pageId: string, place: PagePlace, copy: BookPageLayout): PrintBook {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  checkNewPageId(book, pageId);
  const content = bookPageLayoutSchema.parse(copy);
  const book_ = bookFolder(dataRoot, bookId)!;
  let root = bookPagesDir(dataRoot, bookId);
  if (!root) {
    fs.mkdirSync(path.join(book_, PAGES_DIR));
    root = bookPagesDir(dataRoot, bookId)!;
  }
  const folder = path.join(root, pageId);
  if (fs.lstatSync(folder, { throwIfNoEntry: false })) throw new BookPageRefused(`Le dossier ${bookId}/${PAGES_DIR}/${pageId}/ existe déjà, sans figurer dans print-book.json : rien n'est écrasé.`);
  fs.mkdirSync(folder);
  writeAtomic(folder, LAYOUT_FILE, json(content));
  const next = printBookSchema.parse(place === 'debut' ? { ...book, frontMatter: [...book.frontMatter, pageId] } : { ...book, backMatter: [...book.backMatter, pageId] });
  writeAtomic(dir, 'print-book.json', json(next));
  return next;
}

export function checkNewPageId(book: PrintBook, pageId: string): void {
  if (!slugSchema.safeParse(pageId).success) throw new BookPageRefused(`Identifiant refusé : ${pageId} (minuscules, chiffres et tirets).`);
  if (WINDOWS_RESERVED.test(pageId)) throw new BookPageRefused(`${pageId} : nom réservé par Windows.`);
  if (book.frontMatter.includes(pageId) || book.backMatter.includes(pageId)) throw new BookPageRefused(`La page du livre ${pageId} existe déjà.`);
  if (book.subjects.includes(pageId)) throw new BookPageRefused(`${pageId} est déjà un sujet : choisir un autre identifiant.`);
}

/** Supprimer une page du livre : le dossier va sous `pages/.supprimes/<pageId>.<date>/`, puis la page sort de sa liste. Rien n'est effacé. */
export function deleteBookPage(dataRoot: string, bookId: string, pageId: string, now = new Date()): string {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  if (!book.frontMatter.includes(pageId) && !book.backMatter.includes(pageId)) throw new BookPageRefused(`La page ${pageId} ne figure pas dans print-book.json : rien n'est déplacé.`);
  const folder = bookPageFolder(dataRoot, bookId, pageId);
  if (folder) {
    const root = bookPagesDir(dataRoot, bookId)!;
    const trash = path.join(root, DELETED_PAGES_DIR);
    const stat = fs.lstatSync(trash, { throwIfNoEntry: false });
    if (!stat) fs.mkdirSync(trash);
    else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BookPageRefused(`${bookId}/${PAGES_DIR}/${DELETED_PAGES_DIR}/ n'est pas un dossier réel : rien n'est déplacé.`);
    const target = path.join(trash, `${pageId}.${fileStamp(now)}`);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new BookPageRefused(`${path.basename(target)} existe déjà dans ${DELETED_PAGES_DIR}/ : rien n'est déplacé.`);
    try {
      fs.renameSync(folder, target);
    } catch (e) {
      throw new BookPageRefused(`Le dossier de la page ${pageId} ne peut pas être déplacé (${(e as Error).message}) : le fermer dans les autres programmes, puis recommencer.`);
    }
  }
  const next = printBookSchema.parse({ ...book, frontMatter: book.frontMatter.filter((p) => p !== pageId), backMatter: book.backMatter.filter((p) => p !== pageId) });
  writeAtomic(dir, 'print-book.json', json(next));
  return folder ? `${bookId}/${PAGES_DIR}/${DELETED_PAGES_DIR}/${pageId}.${fileStamp(now)}` : '';
}

/**
 * « Monter » (-1) ou « Descendre » (+1) une partie du livre dans sa liste : pages du début, sujets ou pages de la fin. Une partie ne quitte
 * pas sa liste : une page liminaire reste au début, une page finale à la fin (le début et la fin se choisissent à l'ajout).
 */
export function movePart(dataRoot: string, bookId: string, id: string, step: -1 | 1): PrintBook {
  const { dir, book } = requirePrintBook(dataRoot, bookId);
  const key = book.frontMatter.includes(id) ? 'frontMatter' : book.subjects.includes(id) ? 'subjects' : book.backMatter.includes(id) ? 'backMatter' : null;
  if (key === null) throw new BookPageRefused(`${id} ne figure pas dans print-book.json.`);
  const list = [...book[key]];
  const at = list.indexOf(id);
  const to = at + step;
  if (to < 0 || to >= list.length) throw new BookPageRefused(`${id} est déjà ${step < 0 ? 'la première' : 'la dernière'} de sa liste.`);
  [list[at], list[to]] = [list[to]!, list[at]!];
  const next = printBookSchema.parse({ ...book, [key]: list });
  writeAtomic(dir, 'print-book.json', json(next));
  return next;
}
