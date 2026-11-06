// src/parcours/facts.ts — lit les faits du parcours dans la configuration, GLBInterpreter et le dossier de données. Rien n'est écrit.
// Un refus sur une donnée devient un fait : le menu doit rester affiché pour dire quoi corriger. Une étape dont les précédentes ne sont
// pas valides ne lit rien de plus : elle sera verrouillée.
import fs from 'node:fs';
import path from 'node:path';
import { CollectionRefused, readCollection } from '../data/collection';
import { bookFolder, PricingRefused, readPricing, readPrintBook } from '../data/pricing-file';
import { readBook } from '../glbi/read';
import { evaluate, resolvePages } from '../pricing/calc';
import { loadRates } from '../pricing/rates';
import { deviation } from '../pricing/scenarios';
import { essaiFor, readEssaiControl } from '../render/essai';
import { RenderRefused } from '../render/html';
import type { ConfigState } from '../server/config';
import { GeometryRefused } from '../templates/geometry';
import type { ParcoursFacts } from './steps';

const mtime = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;

function pricingFacts(dataRoot: string, bookId: string): ParcoursFacts['pricing'] {
  const empty = { error: null, retained: false, retainedErrors: [], deviation: [], bookAlert: null };
  let file;
  try {
    file = readPricing(dataRoot, bookId);
  } catch (e) {
    if (e instanceof PricingRefused) return { ...empty, error: e.message };
    throw e;
  }
  const retained = file?.scenarios.find((s) => s.id === file.retainedId);
  if (!retained) return empty;
  const { book, error } = readPrintBook(dataRoot, bookId);
  try {
    return {
      ...empty,
      retained: true,
      retainedErrors: evaluate(loadRates(), retained, new Date()).errors,
      deviation: book ? deviation(book, retained, resolvePages(retained.pages).pages) : [],
      bookAlert: error,
    };
  } catch (e) {
    return { ...empty, retained: true, retainedErrors: [(e as Error).message] };
  }
}

function collectionFacts(dataRoot: string): ParcoursFacts['collection'] {
  try {
    return { exists: readCollection(dataRoot) !== null, error: null };
  } catch (e) {
    if (e instanceof CollectionRefused) return { exists: true, error: e.message };
    throw e;
  }
}

function renderFault(dataRoot: string, bookId: string): string | null {
  try {
    essaiFor(dataRoot, bookId);
    return null;
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused) return e.message;
    throw e;
  }
}

function essaiFacts(dataRoot: string, bookId: string, dir: string): ParcoursFacts['essai'] {
  const { control, error } = readEssaiControl(dataRoot, bookId);
  const ids = (level: string) => (control?.checks ?? []).filter((c) => c.level === level).map((c) => c.id);
  return {
    renderError: renderFault(dataRoot, bookId),
    control: control && { dateMs: Date.parse(control.date), errors: ids('erreur'), alerts: ids('alerte') },
    controlError: error,
    styleMs: mtime(path.join(fs.realpathSync.native(dataRoot), 'collection', 'style.json')),
    printBookMs: mtime(path.join(dir, 'print-book.json')),
  };
}

export function readFacts(state: ConfigState, dir: string | null): ParcoursFacts {
  const facts: ParcoursFacts = {
    configError: state.ok ? null : state.message,
    book: null,
    folder: { exists: false, error: null, printBook: 'absent', printBookError: null },
    pricing: { error: null, retained: false, retainedErrors: [], deviation: [], bookAlert: null },
    collection: { exists: false, error: null },
    essai: { renderError: null, control: null, controlError: null, styleMs: null, printBookMs: null },
  };
  if (!state.ok || dir === null) return facts;
  const { glbRoot, dataRoot } = state.config;
  const reading = readBook(glbRoot, dir);
  facts.book = { bookId: reading.bookId, errors: reading.errors, alerts: reading.alerts };
  if (reading.errors.length > 0 || !reading.bookId) return facts;
  const { bookId } = reading;

  let folder: string | null;
  try {
    folder = bookFolder(dataRoot, bookId);
  } catch (e) {
    if (e instanceof PricingRefused) return { ...facts, folder: { ...facts.folder, error: e.message } };
    throw e;
  }
  if (!folder) return facts;
  const { book, error } = readPrintBook(dataRoot, bookId);
  const absent = mtime(path.join(folder, 'print-book.json')) === null;
  facts.folder = { exists: true, error: null, printBook: book ? 'ok' : absent ? 'absent' : 'invalide', printBookError: error };
  if (!book) return facts;

  facts.pricing = pricingFacts(dataRoot, bookId);
  facts.collection = collectionFacts(dataRoot);
  if (facts.collection.exists && !facts.collection.error) facts.essai = essaiFacts(dataRoot, bookId, folder);
  return facts;
}
