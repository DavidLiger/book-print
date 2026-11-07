// src/rights/registry.ts — lecture et écriture des deux registres (spec §3.8). Mêmes garanties que les autres fichiers de données : écriture
// sûre par `atomic.ts`, refus de tout lien, un fichier invalide n'est jamais écrasé. `collection/rights.json` existe déjà chez David et la
// création de la collection n'écrase rien : les nouvelles valeurs par défaut y arrivent par `addMissingDefaults`, qui n'ajoute que les `id` absents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { writeAtomic } from '../data/atomic';
import { collectionFolder } from '../data/collection';
import { bookFolder } from '../data/pricing-file';
import { SCHEMA_VERSION } from '../schema/common';
import { illustrationFileName } from '../schema/subject';
import { rightsEntrySchema, rightsFileSchema, type IllustrationRights, type RightsEntry, type RightsFile } from '../schema/rights';

export class RightsRefused extends Error {}

export const RIGHTS_FILE = 'rights.json';
const DEFAULTS = fileURLToPath(new URL('../templates/defaults/rights.json', import.meta.url));
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const emptyRights = (): RightsFile => ({ schemaVersion: SCHEMA_VERSION, entries: [], illustrations: [] });

export type RightsScope = 'collection' | 'livre';

function readFile(dir: string, label: string): RightsFile | null {
  const file = path.join(dir, RIGHTS_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new RightsRefused(`${label} n'est pas un fichier réel : rien n'est lu ni écrit.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new RightsRefused(`${label} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.`);
  }
  const parsed = rightsFileSchema.safeParse(value);
  if (!parsed.success) throw new RightsRefused(`${label} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.`);
  return parsed.data;
}

const bookLabel = (bookId: string) => `${bookId}/${RIGHTS_FILE}`;
const COLLECTION_LABEL = `collection/${RIGHTS_FILE}`;

function requireBook(dataRoot: string, bookId: string): string {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) throw new RightsRefused(`Dossier du livre absent : ${bookId}/. Le créer d'abord dans la page.`);
  return dir;
}

function requireCollection(dataRoot: string): string {
  const dir = collectionFolder(dataRoot);
  if (!dir) throw new RightsRefused('collection/ absent : le créer d\'abord dans la page.');
  return dir;
}

export const readCollectionRights = (dataRoot: string): RightsFile => readFile(requireCollection(dataRoot), COLLECTION_LABEL) ?? emptyRights();
export const readBookRights = (dataRoot: string, bookId: string): RightsFile => readFile(requireBook(dataRoot, bookId), bookLabel(bookId)) ?? emptyRights();

/** Une entrée doit porter le même identifiant dans un seul des deux registres : le rattachement ne cite qu'un `id`. */
export function allEntries(collection: RightsFile, book: RightsFile): Map<string, RightsEntry> {
  return new Map([...collection.entries, ...book.entries].map((e) => [e.id, e]));
}

export const defaultEntries = (): RightsEntry[] => rightsFileSchema.parse(JSON.parse(fs.readFileSync(DEFAULTS, 'utf8'))).entries;
export const missingDefaults = (collection: RightsFile): string[] => {
  const known = new Set(collection.entries.map((e) => e.id));
  return defaultEntries().map((e) => e.id).filter((id) => !known.has(id));
};

/** Rien à changer : aucune écriture, le fichier garde sa date et son empreinte. */
function rewrite(dir: string, label: string, change: (file: RightsFile) => RightsFile): RightsFile {
  const before = readFile(dir, label) ?? emptyRights();
  const after = rightsFileSchema.parse(change(structuredClone(before)));
  if (JSON.stringify(after) !== JSON.stringify(before)) writeAtomic(dir, RIGHTS_FILE, json(after));
  return after;
}

/** N'ajoute que les `id` absents ; une entrée existante n'est jamais modifiée. */
export function addMissingDefaults(dataRoot: string): { added: string[]; total: number } {
  const dir = requireCollection(dataRoot);
  const added: string[] = [];
  const file = rewrite(dir, COLLECTION_LABEL, (rights) => {
    const known = new Set(rights.entries.map((e) => e.id));
    for (const entry of defaultEntries()) {
      if (known.has(entry.id)) continue;
      rights.entries.push(entry);
      added.push(entry.id);
    }
    return rights;
  });
  return { added, total: file.entries.length };
}

const parseEntry = (entry: unknown): RightsEntry => {
  const parsed = rightsEntrySchema.safeParse(entry);
  if (!parsed.success) throw new RightsRefused(`Entrée invalide : ${issues(parsed.error)}.`);
  return parsed.data;
};

/** `scope` : le registre où vit l'entrée. Un `id` existant la modifie, un `id` nouveau l'ajoute, s'il n'est pris dans aucun des deux. */
export function saveEntry(dataRoot: string, bookId: string, scope: RightsScope, value: unknown, mode: 'ajout' | 'modification'): RightsEntry {
  const entry = parseEntry(value);
  const inScope = (scope === 'collection' ? readCollectionRights(dataRoot) : readBookRights(dataRoot, bookId)).entries.some((e) => e.id === entry.id);
  if (mode === 'modification' && !inScope) throw new RightsRefused(`Entrée inconnue dans ce registre : ${entry.id}.`);
  if (mode === 'ajout' && allEntries(readCollectionRights(dataRoot), readBookRights(dataRoot, bookId)).has(entry.id)) throw new RightsRefused(`Cette entrée existe déjà : ${entry.id}. La modifier plutôt que l'ajouter.`);
  const change = (file: RightsFile) => ({ ...file, entries: mode === 'ajout' ? [...file.entries, entry] : file.entries.map((e) => (e.id === entry.id ? entry : e)) });
  if (scope === 'collection') rewrite(requireCollection(dataRoot), COLLECTION_LABEL, change);
  else rewrite(requireBook(dataRoot, bookId), bookLabel(bookId), change);
  return entry;
}

export function addBookEntries(dataRoot: string, bookId: string, entries: RightsEntry[]): void {
  rewrite(requireBook(dataRoot, bookId), bookLabel(bookId), (file) => ({ ...file, entries: [...file.entries, ...entries] }));
}

export const illustrationRights = (book: RightsFile, subject: string, zone: string): IllustrationRights | undefined => book.illustrations.find((i) => i.subject === subject && i.zone === zone);

/** Crée l'entrée d'une illustration au dépôt, en gardant les droits déjà rattachés : un remplacement ne les perd pas (décision de David). */
export function ensureIllustrationRights(dataRoot: string, bookId: string, subject: string, zone: string): void {
  rewrite(requireBook(dataRoot, bookId), bookLabel(bookId), (file) => {
    if (illustrationRights(file, subject, zone)) return file;
    return { ...file, illustrations: [...file.illustrations, { subject, zone, file: illustrationFileName(subject, zone), rights: [], aiGenerated: true as const }] };
  });
}

export function setIllustrationRights(dataRoot: string, bookId: string, subject: string, zone: string, rights: string[]): void {
  rewrite(requireBook(dataRoot, bookId), bookLabel(bookId), (file) => {
    if (!illustrationRights(file, subject, zone)) throw new RightsRefused(`Aucune image dans la zone ${zone} : la déposer d'abord.`);
    return { ...file, illustrations: file.illustrations.map((i) => (i.subject === subject && i.zone === zone ? { ...i, rights } : i)) };
  });
}
