// src/server/rights-actions.ts — étape Droits du livre (spec §3.8) : les deux registres, « Ajouter ce qui manque », saisie d'une entrée, `credits.json`.
import { z } from 'zod';
import { entryFaults } from '../checks/images';
import { readPrintBook } from '../data/pricing-file';
import { SubjectRefused } from '../data/subject-file';
import { importCredits, parseCredits, rightsId } from '../rights/credits';
import { addBookEntries, addMissingDefaults, allEntries, missingDefaults, readBookRights, readCollectionRights, RightsRefused, saveEntry } from '../rights/registry';
import { slugSchema, SLUG_PATTERN } from '../schema/common';
import { COMMERCIAL_OK, RIGHTS_KINDS, type RightsEntry } from '../schema/rights';
import type { Config } from './config';
import { reading } from './subject-actions';

export class BadRightsRequest extends Error {}

type Json = Record<string, unknown>;

const dirBody = z.strictObject({ dir: z.string() });
const creditsBody = z.strictObject({ dir: z.string(), content: z.string() });
const entryBody = z.strictObject({
  dir: z.string(),
  scope: z.enum(['collection', 'livre']),
  /** Absent : une nouvelle entrée, dont l'identifiant est calculé. Présent : l'entrée à modifier ; il ne change jamais. */
  id: slugSchema.optional(),
  entry: z.strictObject({
    kind: z.enum(RIGHTS_KINDS),
    name: z.string(),
    author: z.string(),
    license: z.string(),
    url: z.string(),
    credit: z.string(),
    commercialOk: z.enum(COMMERCIAL_OK),
  }),
});

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadRightsRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

const shown = (e: RightsEntry) => ({ ...e, faults: entryFaults(e) });

function state(config: Config, dir: string): Json {
  const { bookId } = reading(config, dir);
  const base = { bookId, kinds: RIGHTS_KINDS };
  try {
    const collection = readCollectionRights(config.dataRoot);
    const book = readBookRights(config.dataRoot, bookId);
    return { ...base, error: null, collection: collection.entries.map(shown), book: book.entries.map(shown), missing: missingDefaults(collection) };
  } catch (e) {
    if (e instanceof RightsRefused) return { ...base, error: e.message, collection: [], book: [], missing: [] };
    throw e;
  }
}

function saveFromPage(config: Config, value: z.infer<typeof entryBody>): Json {
  const { dir, scope, id, entry } = value;
  const { bookId } = reading(config, dir);
  const newId = id ?? rightsId(entry.author, entry.name);
  if (!SLUG_PATTERN.test(newId)) throw new RightsRefused('Aucun identifiant possible : renseigner le nom.');
  const { url, ...rest } = entry;
  const clean = url.trim();
  saveEntry(config.dataRoot, bookId, scope, { id: newId, ...rest, ...(clean ? { url: clean } : {}) }, id ? 'modification' : 'ajout');
  return { saved: newId, ...state(config, dir) };
}

function importFile(config: Config, value: z.infer<typeof creditsBody>): Json {
  const { dir, content } = value;
  const { bookId } = reading(config, dir);
  const { book, error } = readPrintBook(config.dataRoot, bookId);
  if (!book) throw new SubjectRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  const file = parseCredits(content);
  const known = allEntries(readCollectionRights(config.dataRoot), readBookRights(config.dataRoot, bookId));
  const result = importCredits(file, new Set(known.keys()), book.edition.lang);
  if (result.added.length > 0) addBookEntries(config.dataRoot, bookId, result.added);
  return { imported: { added: result.added.map((e) => e.id), kept: result.kept, originals: result.originals, skipped: result.skipped }, ...state(config, dir) };
}

export const RIGHTS_ACTIONS: Record<string, (body: unknown, config: Config) => Json> = {
  '/api/droits/state': (body, config) => state(config, parse(dirBody, body).dir),
  '/api/droits/completer': (body, config) => {
    const { dir } = parse(dirBody, body);
    return { completed: addMissingDefaults(config.dataRoot), ...state(config, dir) };
  },
  '/api/droits/enregistrer': (body, config) => saveFromPage(config, parse(entryBody, body)),
  '/api/droits/credits': (body, config) => importFile(config, parse(creditsBody, body)),
};
