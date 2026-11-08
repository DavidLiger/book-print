// src/parcours/facts.ts — lit les faits du parcours dans la configuration, GLBInterpreter et le dossier de données. Rien n'est écrit.
// Un refus sur une donnée devient un fait : le menu doit rester affiché pour dire quoi corriger. Une étape dont les précédentes ne sont
// pas valides ne lit rien de plus : elle sera verrouillée.
import fs from 'node:fs';
import path from 'node:path';
import { entryFaults } from '../checks/images';
import { CollectionRefused, readCollection } from '../data/collection';
import { bookFolder, PricingRefused, readPricing, readPrintBook } from '../data/pricing-file';
import { readResearch, readSubject, SubjectRefused } from '../data/subject-file';
import { readBook, type SceneReading } from '../glbi/read';
import { evaluate, resolvePages } from '../pricing/calc';
import { loadRates } from '../pricing/rates';
import { deviation } from '../pricing/scenarios';
import { bookSnapshot, essaiFor, readEssaiControl } from '../render/essai';
import { RenderRefused } from '../render/html';
import { imageChecks, subjectContext, subjectTitle } from '../render/subject';
import { missingDefaults, readBookRights, readCollectionRights, RightsRefused } from '../rights/registry';
import type { PrintBook } from '../schema/print-book';
import type { ConfigState } from '../server/config';
import { GeometryRefused } from '../templates/geometry';
import { readWorkflows } from '../comfy/workflow-file';
import { WORKFLOW_KINDS, WORKFLOW_LABELS, WorkflowRefused } from '../comfy/workflow';
import { allEntries } from '../rights/registry';
import { coherenceAlerts, imageStyles, referenceToCheck, styleFaults } from '../styles/library';
import { okStyle, readStyles, StyleRefused } from '../styles/read';
import type { Subject } from '../schema/subject';
import { effectiveRights } from '../comfy/workflow-file';
import type { ParcoursFacts, SubjectFacts } from './steps';

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

function essaiFacts(dataRoot: string, book: PrintBook, dir: string): ParcoursFacts['essai'] {
  const { bookId } = book;
  const { control, error } = readEssaiControl(dataRoot, bookId);
  const ids = (level: string) => (control?.checks ?? []).filter((c) => c.level === level).map((c) => c.id);
  return {
    renderError: renderFault(dataRoot, bookId),
    control: control && { dateMs: Date.parse(control.date), errors: ids('erreur'), alerts: ids('alerte') },
    controlError: error,
    styleMs: mtime(path.join(fs.realpathSync.native(dataRoot), 'collection', 'style.json')),
    printBookMs: mtime(path.join(dir, 'print-book.json')),
    bookChanged: control?.book === undefined ? null : control.book !== bookSnapshot(book),
  };
}

function droitsFacts(dataRoot: string, bookId: string): ParcoursFacts['droits'] {
  try {
    const collection = readCollectionRights(dataRoot);
    const book = readBookRights(dataRoot, bookId);
    const entries = [...collection.entries, ...book.entries];
    const shared = book.entries.filter((e) => collection.entries.some((c) => c.id === e.id)).map((e) => `${e.id} : présent dans les deux registres`);
    const invalid = entries.flatMap((e) => entryFaults(e).map((fault) => `${e.id} : ${fault}`));
    const refused = entries.filter((e) => e.commercialOk === 'non').map((e) => `${e.id} : usage commercial refusé`);
    return { error: null, missing: missingDefaults(collection).length, faults: [...shared, ...invalid, ...refused], toCheck: entries.filter((e) => e.commercialOk === 'a-verifier').map((e) => e.id) };
  } catch (e) {
    if (e instanceof RightsRefused || e instanceof CollectionRefused) return { error: e.message, missing: 0, faults: [], toCheck: [] };
    throw e;
  }
}

function workflowFacts(dataRoot: string, bookId: string): ParcoursFacts['workflows'] {
  try {
    const w = readWorkflows(dataRoot, bookId);
    const todo: string[] = [];
    const faults: string[] = [];
    for (const kind of WORKFLOW_KINDS) {
      const s = w[kind];
      const label = WORKFLOW_LABELS[kind];
      if (s.state === 'absent') todo.push(`Déposer le workflow de ${label}.`);
      else if (s.state === 'refuse') faults.push(s.message);
      else if (s.rightsFaults.length > 0) faults.push(`Workflow de ${label} : ${s.rightsFaults.join(' ; ')}.`);
      else if (effectiveRights(s).length === 0) todo.push(`Cocher les droits du workflow de ${label}.`);
    }
    return { error: null, todo, faults };
  } catch (e) {
    if (e instanceof WorkflowRefused || e instanceof RightsRefused || e instanceof CollectionRefused) return { error: e.message, todo: [], faults: [] };
    throw e;
  }
}

/** Étape Styles (IC2) : la bibliothèque, le style par défaut du livre, le style des zones, et la cohérence des images déjà produites. */
function styleFacts(dataRoot: string, book: PrintBook): ParcoursFacts['styles'] {
  const empty = { error: null, count: 0, faults: [], todo: [], alerts: [] };
  try {
    const styles = readStyles(dataRoot);
    const registry = allEntries(readCollectionRights(dataRoot), readBookRights(dataRoot, book.bookId));
    const known = new Set(styles.map((s) => s.id));
    const faults = styles.flatMap((s) => styleFaults(s, registry));
    const subjects: Subject[] = book.subjects.flatMap((id) => {
      try {
        return [readSubject(dataRoot, book.bookId, id)];
      } catch (e) {
        if (e instanceof SubjectRefused) return [];
        throw e;
      }
    });
    if (book.defaultStyle !== undefined && !known.has(book.defaultStyle)) faults.push(`Style par défaut inconnu de la bibliothèque : ${book.defaultStyle}.`);
    for (const s of subjects) for (const [zone, id] of Object.entries(s.generationStyles ?? {})) if (!known.has(id)) faults.push(`${s.id}/${zone} : style inconnu de la bibliothèque (${id}).`);
    const todo = styles.length > 0 && book.defaultStyle === undefined ? ['Choisir le style par défaut du livre.'] : [];
    const toCheck = styles.flatMap((s) => {
      const ok = okStyle(s);
      return ok && referenceToCheck(ok.style, registry) && ok.style.reference.type !== 'aucune' ? [`Référence à vérifier : ${ok.style.reference.rights} (${ok.style.name}).`] : [];
    });
    return { error: null, count: styles.length, faults, todo, alerts: [...coherenceAlerts(imageStyles(subjects), styles), ...toCheck] };
  } catch (e) {
    if (e instanceof StyleRefused || e instanceof RightsRefused || e instanceof CollectionRefused) return { ...empty, error: e.message };
    throw e;
  }
}

function illustrationFacts(dataRoot: string, bookId: string, id: string, scenes: SceneReading[]): SubjectFacts['illustrations'] {
  try {
    const { zones, checks } = imageChecks(subjectContext(dataRoot, bookId, id, scenes));
    const details = (level: string) => checks.filter((c) => c.level === level).flatMap((c) => c.details.map((d) => `${c.id}, ${d}`));
    return { error: null, zones: zones.length, missing: zones.filter((z) => !z.illustration).length, errors: [...zones.flatMap((z) => z.fault ?? []), ...details('erreur')], alerts: details('alerte') };
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof CollectionRefused || e instanceof RightsRefused || e instanceof PricingRefused) return { error: e.message, zones: 0, missing: 0, errors: [], alerts: [] };
    throw e;
  }
}

function subjectFacts(dataRoot: string, book: PrintBook, id: string, scenes: SceneReading[]): SubjectFacts {
  const empty: SubjectFacts = {
    id, title: id, error: null, status: null, pages: 0, template: null, theme: null,
    research: { state: 'absent', error: null }, blocks: { total: 0, valide: 0, aRelire: 0, aReprendre: 0 }, claims: { total: 0, propose: 0 },
    illustrations: { error: null, zones: 0, missing: 0, errors: [], alerts: [] },
  };
  let subject;
  try {
    subject = readSubject(dataRoot, book.bookId, id);
  } catch (e) {
    if (e instanceof SubjectRefused) return { ...empty, error: e.message };
    throw e;
  }
  const count = (state: string) => subject.blocks.filter((b) => b.state === state).length;
  const facts: SubjectFacts = {
    ...empty,
    title: subjectTitle(subject, scenes.find((s) => s.id === subject.sceneId), book.edition.lang) || id,
    status: subject.status,
    pages: subject.pages,
    template: subject.template,
    theme: subject.variant.theme,
    blocks: { total: subject.blocks.length, valide: count('valide'), aRelire: count('a-relire'), aReprendre: count('a-reprendre') },
    illustrations: illustrationFacts(dataRoot, book.bookId, id, scenes),
  };
  try {
    const research = readResearch(dataRoot, book.bookId, id);
    if (research) return { ...facts, research: { state: 'ok', error: null }, claims: { total: research.claims.length, propose: research.claims.filter((c) => c.status === 'propose').length } };
    return facts;
  } catch (e) {
    if (e instanceof SubjectRefused) return { ...facts, research: { state: 'invalide', error: e.message } };
    throw e;
  }
}

export function readFacts(state: ConfigState, dir: string | null): ParcoursFacts {
  const facts: ParcoursFacts = {
    configError: state.ok ? null : state.message,
    book: null,
    folder: { exists: false, error: null, printBook: 'absent', printBookError: null },
    pricing: { error: null, retained: false, retainedErrors: [], deviation: [], bookAlert: null },
    collection: { exists: false, error: null },
    essai: { renderError: null, control: null, controlError: null, styleMs: null, printBookMs: null, bookChanged: null },
    droits: { error: null, missing: 0, faults: [], toCheck: [] },
    workflows: { error: null, todo: [], faults: [] },
    styles: { error: null, count: 0, faults: [], todo: [], alerts: [] },
    subjects: [],
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
  if (facts.collection.exists && !facts.collection.error) {
    facts.essai = essaiFacts(dataRoot, book, folder);
    facts.droits = droitsFacts(dataRoot, bookId);
    facts.workflows = workflowFacts(dataRoot, bookId);
    facts.styles = styleFacts(dataRoot, book);
  }
  facts.subjects = book.subjects.map((id) => subjectFacts(dataRoot, book, id, reading.scenes));
  return facts;
}
