// src/data/create-book.ts — crée le dossier de données d'un livre (spec §3.2, architecture §4).
// Aucune écriture hors de `dataRoot` ; un fichier existant n'est jamais écrasé.
import fs from 'node:fs';
import path from 'node:path';
import { bookIdSchema, SCHEMA_VERSION } from '../schema/common';
import { newPrintBook } from '../schema/print-book';
import { isInside } from '../glbi/paths';

export const DATA_GITIGNORE = ['*/illustrations/', '*/export/', '*/.cache/'];
const BOOK_DIRS = ['subjects', 'illustrations', 'export'];

export interface WriteReport {
  created: string[];
  kept: string[];
}

export interface CreateResult extends WriteReport {
  bookId: string;
  alerts: string[];
}

export class CreateRefused extends Error {}

/** Crée `<root>/<rel>` segment par segment : un lien ou une jonction ferait sortir de `root` (Windows : jonction = lien). */
export function ensureDir(root: string, segments: string[], out: WriteReport): void {
  let current = root;
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment);
    const rel = `${segments.slice(0, i + 1).join('/')}/`;
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      fs.mkdirSync(current);
      out.created.push(rel);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CreateRefused(`${rel} n'est pas un dossier réel : rien n'est écrit`);
    } else if (i === segments.length - 1) {
      out.kept.push(rel);
    }
  }
}

/** Écrit sans jamais écraser : `wx` échoue si le chemin existe, même s'il s'agit d'un lien. */
export function writeNew(root: string, rel: string, content: string, out: WriteReport): void {
  try {
    fs.writeFileSync(path.join(root, ...rel.split('/')), content, { encoding: 'utf8', flag: 'wx' });
    out.created.push(rel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    out.kept.push(rel);
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function createBookFolder(dataRoot: string, bookId: string): CreateResult {
  const id = bookIdSchema.safeParse(bookId);
  if (!id.success) throw new CreateRefused(`bookId refusé : ${bookId}`);
  const root = fs.realpathSync.native(dataRoot);
  const out: CreateResult = { bookId, created: [], kept: [], alerts: [] };

  ensureDir(root, [bookId], out);
  for (const dir of BOOK_DIRS) ensureDir(root, [bookId, dir], out);
  if (!isInside(root, fs.realpathSync.native(path.join(root, bookId)))) {
    throw new CreateRefused(`${bookId}/ sort de dataRoot : rien n'est écrit`);
  }

  writeNew(root, `${bookId}/print-book.json`, json(newPrintBook(bookId)), out);
  writeNew(root, `${bookId}/rights.json`, json({ schemaVersion: SCHEMA_VERSION, entries: [], illustrations: [] }), out);
  writeNew(root, '.gitignore', `${DATA_GITIGNORE.join('\n')}\n`, out);

  // Un `.gitignore` conservé peut ne pas protéger les illustrations et les exports du repo privé.
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  const missing = DATA_GITIGNORE.filter((l) => !lines.includes(l));
  if (missing.length) out.alerts.push(`.gitignore des données à compléter à la main : ${missing.join(', ')}`);
  return out;
}
