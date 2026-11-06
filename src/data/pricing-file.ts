// src/data/pricing-file.ts — `<bookId>/pricing.json` (spec §9.6). Contrairement aux fichiers de MP1, celui-ci est réécrit à
// chaque enregistrement : écriture dans un fichier temporaire puis renommage, pour qu'une coupure ne laisse jamais un
// fichier à moitié écrit. Un fichier existant et invalide n'est jamais écrasé. `print-book.json` est seulement lu.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isInside } from '../glbi/paths';
import { emptyPricing, pricingFileSchema, type PricingFile, type Scenario, type ScenarioInput } from '../pricing/scenarios';
import { bookIdSchema } from '../schema/common';
import { printBookSchema, type PrintBook } from '../schema/print-book';
import { writeAtomic } from './atomic';

export class PricingRefused extends Error {}

const FILE = 'pricing.json';
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

/** Dossier réel du livre sous `dataRoot`, `null` s'il n'existe pas encore. Mêmes refus que `create-book.ts`. */
export function bookFolder(dataRoot: string, bookId: string): string | null {
  if (!bookIdSchema.safeParse(bookId).success) throw new PricingRefused(`bookId refusé : ${bookId}`);
  const root = fs.realpathSync.native(dataRoot);
  const dir = path.join(root, bookId);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PricingRefused(`${bookId}/ n'est pas un dossier réel : rien n'est lu ni écrit`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new PricingRefused(`${bookId}/ sort de dataRoot : rien n'est lu ni écrit`);
  return dir;
}

function requireFolder(dataRoot: string, bookId: string): string {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) throw new PricingRefused(`Dossier du livre absent : ${bookId}/. Le créer d'abord dans la page.`);
  return dir;
}

function readFrom(dir: string, bookId: string): PricingFile {
  const file = path.join(dir, FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return emptyPricing(bookId);
  if (!stat.isFile()) throw new PricingRefused(`${bookId}/${FILE} n'est pas un fichier réel : rien n'est lu ni écrit`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PricingRefused(`${bookId}/${FILE} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.`);
  }
  const parsed = pricingFileSchema.safeParse(value);
  if (!parsed.success) throw new PricingRefused(`${bookId}/${FILE} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.`);
  if (parsed.data.bookId !== bookId) throw new PricingRefused(`${bookId}/${FILE} porte le bookId ${parsed.data.bookId}. Le fichier est conservé tel quel.`);
  return parsed.data;
}

function writeTo(dir: string, content: PricingFile): void {
  writeAtomic(dir, FILE, `${JSON.stringify(content, null, 2)}\n`);
}

function update(dataRoot: string, bookId: string, change: (file: PricingFile) => void): PricingFile {
  const dir = requireFolder(dataRoot, bookId);
  const file = readFrom(dir, bookId);
  change(file);
  const checked = pricingFileSchema.parse(file);
  writeTo(dir, checked);
  return checked;
}

export function readPricing(dataRoot: string, bookId: string): PricingFile | null {
  const dir = bookFolder(dataRoot, bookId);
  return dir === null ? null : readFrom(dir, bookId);
}

function nextId(file: PricingFile): string {
  const used = file.scenarios.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
  return `s${Math.max(0, ...used) + 1}`;
}

/** Avec `id` : remplace ce scénario, en gardant sa place. Sans `id` : l'ajoute à la fin. */
export function saveScenario(dataRoot: string, bookId: string, input: ScenarioInput, id?: string): PricingFile {
  return update(dataRoot, bookId, (file) => {
    if (id === undefined) {
      file.scenarios.push({ ...input, id: nextId(file) });
      return;
    }
    const at = file.scenarios.findIndex((s) => s.id === id);
    if (at < 0) throw new PricingRefused(`Scénario inconnu : ${id}`);
    file.scenarios[at] = { ...input, id };
  });
}

export function deleteScenario(dataRoot: string, bookId: string, id: string): PricingFile {
  return update(dataRoot, bookId, (file) => {
    if (!file.scenarios.some((s) => s.id === id)) throw new PricingRefused(`Scénario inconnu : ${id}`);
    file.scenarios = file.scenarios.filter((s: Scenario) => s.id !== id);
    if (file.retainedId === id) file.retainedId = null;
  });
}

/** Un seul scénario retenu : `null` retire la marque. */
export function retainScenario(dataRoot: string, bookId: string, id: string | null): PricingFile {
  return update(dataRoot, bookId, (file) => {
    if (id !== null && !file.scenarios.some((s) => s.id === id)) throw new PricingRefused(`Scénario inconnu : ${id}`);
    file.retainedId = id;
  });
}

/** Lecture seule, pour l'écart du §9.6. Un `print-book.json` illisible se signale, sans bloquer le simulateur. */
export function readPrintBook(dataRoot: string, bookId: string): { book: PrintBook | null; error: string | null } {
  const dir = bookFolder(dataRoot, bookId);
  if (!dir) return { book: null, error: null };
  const file = path.join(dir, 'print-book.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { book: null, error: `${bookId}/print-book.json absent : écart non contrôlé.` };
  if (!stat.isFile()) return { book: null, error: `${bookId}/print-book.json n'est pas un fichier réel : écart non contrôlé.` };
  try {
    const parsed = printBookSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success) return { book: parsed.data, error: null };
    return { book: null, error: `${bookId}/print-book.json invalide : ${issues(parsed.error)}. Écart non contrôlé.` };
  } catch (e) {
    return { book: null, error: `${bookId}/print-book.json illisible : ${(e as Error).message}. Écart non contrôlé.` };
  }
}
