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
import { RenderRefused } from '../render/html';
import { imageChecks, readyErrors, strayIllustrations, subjectContext, subjectTitle, type QrSource } from '../render/subject';
import { applyBookFiche } from '../render/html';
import { blocksGap, duplicateFault, expectedBlocks } from '../research/blocks';
import { reviewState } from '../schema/block';
import { readTemplates, templateOf, TEMPLATES_DIR } from '../templates/files';
import { missingDefaults, readBookRights, readCollectionRights, RightsRefused } from '../rights/registry';
import type { PrintBook } from '../schema/print-book';
import type { ConfigState } from '../server/config';
import { GeometryRefused } from '../templates/geometry';
import { overlapFaults } from '../checks/overlaps';
import { withOutlines } from '../data/contour-file';
import type { Part } from '../images/contour';
import { layoutOf } from '../layout/files';
import { formatLabel, formatOf, placeMiseEnPage, previewFirstPage, sameFormat, type MiseEnPage } from '../layout/model';
import { startFault } from '../layout/place';
import { isLayout } from '../layout/model';
import { firstPageOf, readSubjectLayout } from '../data/subject-file';
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

/** Étape Gabarits (GB1) : les fichiers de `collection/gabarits/`, et les sujets du livre posés sur un gabarit absent. */
/** C17 d'une mise en page du format du livre, posée comme dans son aperçu. Une mise en page qui ne se pose pas n'a pas de C17 ici. */
function modelOverlaps(model: MiseEnPage, book: PrintBook, margins: Parameters<typeof placeMiseEnPage>[2]): string[] {
  try {
    return overlapFaults(placeMiseEnPage(model, book.edition.trim, margins, previewFirstPage(model))).map((d) => `${model.id} : C17, ${d}`);
  } catch (e) {
    if (e instanceof GeometryRefused) return [];
    throw e;
  }
}

function gabaritFacts(dataRoot: string, book: PrintBook): ParcoursFacts['gabarits'] {
  const empty = { error: null, valid: 0, invalid: [], orphans: [], overlaps: [] };
  try {
    const style = readCollection(dataRoot)?.style ?? null;
    const library = readTemplates(dataRoot, style);
    if (library.error) return { ...empty, error: library.error };
    const ids = new Set(library.entries.map((e) => e.id));
    // Un sujet qui a sa copie (ED1) ne dépend plus de son modèle (MP-24) : seuls les sujets d'avant ED1 peuvent être orphelins.
    const orphans = book.subjects.flatMap((id) => {
      try {
        const subject = readSubject(dataRoot, book.bookId, id);
        if (readSubjectLayout(dataRoot, book.bookId, id)) return [];
        return ids.has(subject.template) ? [] : [`${id} : gabarit ${subject.template} absent de collection/${TEMPLATES_DIR}/.`];
      } catch (e) {
        if (e instanceof SubjectRefused) return [];
        throw e;
      }
    });
    // Une mise en page d'un autre format n'est ni comptée ni en erreur : `collection/` est commune à tous les livres (décision de David, ED1).
    const usable = library.entries.flatMap((e) => (e.template && sameFormat(e.template, book.edition.trim) ? [e.template] : []));
    return {
      error: null,
      valid: usable.length,
      invalid: library.entries.filter((e) => e.error).map((e) => `${e.file} : ${e.error}`),
      orphans,
      overlaps: style ? usable.flatMap((m) => modelOverlaps(m, book, style.margins)) : [],
    };
  } catch (e) {
    if (e instanceof CollectionRefused) return { ...empty, error: e.message };
    throw e;
  }
}

type LayoutFacts = Pick<SubjectFacts, 'templateError' | 'blocksGap' | 'miseEnPage' | 'duplicateBlocks'>;

/**
 * Mise en page d'un sujet : sa copie (`layout.json`, ED1), sinon le gabarit de la collection (GB1) ; absente ou invalide, ou modifiée depuis
 * l'import, ce qui change les blocs attendus. Format du livre, côté de départ (C16) et C17 pour l'étape Mise en page.
 */
export function subjectLayoutFacts(dataRoot: string, book: PrintBook, subject: Subject): LayoutFacts {
  const none: LayoutFacts = { templateError: null, blocksGap: { missing: [], extra: [] }, miseEnPage: { source: null, errors: [] }, duplicateBlocks: null };
  try {
    const read = readCollection(dataRoot);
    if (!read) return none;
    const style = applyBookFiche(read.style, book);
    let copy;
    try {
      copy = readSubjectLayout(dataRoot, book.bookId, subject.id);
    } catch (e) {
      if (e instanceof SubjectRefused) return { ...none, templateError: e.message };
      throw e;
    }
    let model: MiseEnPage;
    if (copy) model = layoutOf(copy);
    else {
      const found = templateOf(readTemplates(dataRoot, style), subject.template);
      if ('error' in found) return { ...none, templateError: found.error };
      model = found.template;
    }
    const errors: string[] = [];
    const format = formatOf(model);
    if (format && !sameFormat(model, book.edition.trim)) errors.push(`Mise en page faite pour ${formatLabel(format)} : le livre est en ${formatLabel(book.edition.trim)}.`);
    else {
      try {
        const first = firstPageOf(dataRoot, book, subject.id);
        const side = isLayout(model) ? startFault(model, first) : null;
        if (side) errors.push(`C16, ${side}`);
        else {
          // C17 sur le contour d'un détouré qui a son image (ED2), sur sa boîte sinon.
          const placed = withOutlines(placeMiseEnPage(model, book.edition.trim, style.margins, first), dataRoot, book.bookId, subject.id, (zone) => subject.illustrations.some((i) => i.zone === zone));
          errors.push(...overlapFaults(placed).map((d) => `C17, ${d}`));
        }
      } catch (e) {
        if (e instanceof GeometryRefused) errors.push(e.message);
        else if (!(e instanceof SubjectRefused)) throw e;
      }
    }
    const miseEnPage = { source: copy ? ('layout.json' as const) : ('gabarit' as const), errors };
    const expected = expectedBlocks(model, style.fiche, book.edition.lang);
    const duplicateBlocks = duplicateFault(expected);
    if (subject.blocks.length === 0) return { ...none, miseEnPage, duplicateBlocks };
    return { ...none, miseEnPage, duplicateBlocks, blocksGap: blocksGap(subject.blocks, expected) };
  } catch (e) {
    if (e instanceof CollectionRefused || e instanceof RenderRefused) return none;
    throw e;
  }
}

/** Une partie opaque que le contour d'un détouré découpe (ED2) : sa taille et sa place, en pixels de l'image. */
export const partAlert = (zone: string, p: Part) => `${zone} : partie détachée de ${p.pixels} px, de (${p.gauche}, ${p.haut}) à (${p.droite}, ${p.bas}), coupée par le contour`;

function illustrationFacts(dataRoot: string, bookId: string, id: string, scenes: SceneReading[], qr: QrSource): SubjectFacts['illustrations'] {
  try {
    const ctx = subjectContext(dataRoot, bookId, id, scenes, qr);
    const { zones, checks } = imageChecks(ctx);
    const details = (level: string) => checks.filter((c) => c.level === level).flatMap((c) => c.details.map((d) => `${c.id}, ${d}`));
    // Une partie opaque détachée est découpée par le contour (ED2) : l'alerte la nomme.
    const parts = zones.flatMap((z) => z.parts.map((p) => partAlert(z.zone, p)));
    return { error: null, zones: zones.length, missing: zones.filter((z) => !z.illustration).length, errors: [...strayIllustrations(ctx), ...zones.flatMap((z) => z.fault ?? []), ...details('erreur')], alerts: [...details('alerte'), ...parts] };
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof CollectionRefused || e instanceof RightsRefused || e instanceof PricingRefused) return { error: e.message, zones: 0, missing: 0, errors: [], alerts: [] };
    throw e;
  }
}

/** Les contrôles que les données donnent, pour un sujet « prêt » seulement (ED6) : un sujet qui ne se pose plus n'en a pas, son erreur est déjà dite. */
function readyFor(dataRoot: string, bookId: string, id: string, scenes: SceneReading[], qr: QrSource, research: Parameters<typeof readyErrors>[1], facts: SubjectFacts): SubjectFacts['ready'] {
  try {
    return { errors: readyErrors(subjectContext(dataRoot, bookId, id, scenes, qr), research, facts.miseEnPage.errors) };
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof CollectionRefused || e instanceof RightsRefused || e instanceof PricingRefused) return { errors: [e.message] };
    throw e;
  }
}

function subjectFacts(dataRoot: string, book: PrintBook, id: string, scenes: SceneReading[], qr: QrSource): SubjectFacts {
  const empty: SubjectFacts = {
    id, title: id, error: null, status: null, pages: 0, template: null, theme: null,
    templateError: null, blocksGap: { missing: [], extra: [] }, miseEnPage: { source: null, errors: [] }, duplicateBlocks: null,
    research: { state: 'absent', error: null }, blocks: { total: 0, valide: 0, aRelire: 0, aReprendre: 0 }, claims: { total: 0, propose: 0 },
    illustrations: { error: null, zones: 0, missing: 0, errors: [], alerts: [] },
    ready: { errors: [] },
  };
  let subject;
  try {
    subject = readSubject(dataRoot, book.bookId, id);
  } catch (e) {
    if (e instanceof SubjectRefused) return { ...empty, error: e.message };
    throw e;
  }
  // Un bloc n'est relu que si son texte et son en-tête le sont (ED4).
  const count = (state: string) => subject.blocks.filter((b) => reviewState(b) === state).length;
  const facts: SubjectFacts = {
    ...empty,
    title: subjectTitle(subject, scenes.find((s) => s.id === subject.sceneId), book.edition.lang) || id,
    status: subject.status,
    pages: subject.pages,
    template: subject.template,
    theme: subject.variant.theme,
    blocks: { total: subject.blocks.length, valide: count('valide'), aRelire: count('a-relire'), aReprendre: count('a-reprendre') },
    illustrations: illustrationFacts(dataRoot, book.bookId, id, scenes, qr),
    ...subjectLayoutFacts(dataRoot, book, subject),
  };
  try {
    const research = readResearch(dataRoot, book.bookId, id);
    const withReady = (f: SubjectFacts): SubjectFacts => (f.status === 'prêt' ? { ...f, ready: readyFor(dataRoot, book.bookId, id, scenes, qr, research, f) } : f);
    if (research) return withReady({ ...facts, research: { state: 'ok', error: null }, claims: { total: research.claims.length, propose: research.claims.filter((c) => c.status === 'propose').length } });
    return withReady(facts);
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
    gabarits: { error: null, valid: 0, invalid: [], orphans: [], overlaps: [] },
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
    facts.gabarits = gabaritFacts(dataRoot, book);
    facts.droits = droitsFacts(dataRoot, bookId);
    facts.workflows = workflowFacts(dataRoot, bookId);
    facts.styles = styleFacts(dataRoot, book);
  }
  const qr: QrSource = { glbRoot, origin: reading.origin };
  facts.subjects = book.subjects.map((id) => subjectFacts(dataRoot, book, id, reading.scenes, qr));
  return facts;
}
