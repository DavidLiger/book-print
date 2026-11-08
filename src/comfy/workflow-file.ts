// src/comfy/workflow-file.ts — `collection/workflows/` du dossier de données, versionné dans le repo privé (IC1, question 2). Chaque dépôt écrit un
// fichier daté, `<type>.<date>.json`, tel que David l'a déposé, jamais réécrit. `workflows.json` nomme le fichier en vigueur de chaque type,
// son empreinte et les droits cochés par David. Une empreinte qui ne correspond plus refuse le workflow : il a été modifié à la main.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from '../data/atomic';
import { collectionFolder } from '../data/collection';
import { isInside } from '../glbi/paths';
import { readBookRights, readCollectionRights, allEntries } from '../rights/registry';
import { schemaVersionSchema, slugSchema, uniqueList } from '../schema/common';
import { fieldOf, graphFaults, IGNORED_WORKFLOW_KINDS, parseGraph, sha256, SPECS, WORKFLOW_KINDS, WORKFLOW_LABELS, WORKFLOW_RIGHTS_KINDS, WorkflowRefused, type Graph, type WorkflowKind } from './workflow';

export const WORKFLOWS_DIR = 'workflows';
export const WORKFLOWS_INDEX = 'workflows.json';
const FILE_PATTERN = /^(generation|agrandissement)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.json$/;

const entrySchema = z.strictObject({
  file: z.string().regex(FILE_PATTERN, 'nom de fichier de workflow attendu'),
  date: z.iso.datetime(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rights: uniqueList(slugSchema, 'droit'),
});
const indexSchema = z.strictObject({ schemaVersion: schemaVersionSchema, generation: entrySchema.optional(), agrandissement: entrySchema.optional() });
export type WorkflowEntry = z.infer<typeof entrySchema>;
type WorkflowIndex = z.infer<typeof indexSchema>;

export type WorkflowState =
  | { state: 'absent' }
  | { state: 'refuse'; message: string; entry: WorkflowEntry | null }
  | { state: 'ok'; entry: WorkflowEntry; graph: Graph; rightsFaults: string[]; ignored: string[] };

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** `collection/workflows/`, réel, sous dataRoot. `create` : créé au premier dépôt. */
function workflowsFolder(dataRoot: string, create: boolean): string | null {
  const collection = collectionFolder(dataRoot);
  if (!collection) throw new WorkflowRefused('collection/ absent : le créer d\'abord dans la page.');
  const dir = path.join(collection, WORKFLOWS_DIR);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) {
    if (!create) return null;
    fs.mkdirSync(dir);
    return dir;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkflowRefused('collection/workflows/ n\'est pas un dossier réel : rien n\'est lu ni écrit.');
  if (!isInside(fs.realpathSync.native(dataRoot), fs.realpathSync.native(dir))) throw new WorkflowRefused('collection/workflows/ sort de dataRoot : rien n\'est lu ni écrit.');
  return dir;
}

function readIndex(dir: string): WorkflowIndex {
  const file = path.join(dir, WORKFLOWS_INDEX);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { schemaVersion: 1 };
  if (!stat.isFile()) throw new WorkflowRefused(`collection/workflows/${WORKFLOWS_INDEX} n'est pas un fichier réel.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new WorkflowRefused(`collection/workflows/${WORKFLOWS_INDEX} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.`);
  }
  const parsed = indexSchema.safeParse(value);
  if (!parsed.success) throw new WorkflowRefused(`collection/workflows/${WORKFLOWS_INDEX} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.`);
  return parsed.data;
}

const registryOf = (dataRoot: string, bookId: string | null) =>
  allEntries(readCollectionRights(dataRoot), bookId ? readBookRights(dataRoot, bookId) : { schemaVersion: 1, entries: [], illustrations: [] });

/** Droits d'un workflow cochés en IC1 et ignorés depuis IC2 : une référence de style vient du style (question 6). Le fichier n'est pas réécrit. */
export function ignoredRights(dataRoot: string, bookId: string | null, rights: string[]): string[] {
  const registry = registryOf(dataRoot, bookId);
  return rights.filter((id) => (IGNORED_WORKFLOW_KINDS as readonly string[]).includes(registry.get(id)?.kind ?? ''));
}

/** Droits d'un workflow contrôlés contre les deux registres : inconnus, ou d'un type qu'un workflow ne porte pas. `lenient` : un droit ignoré n'est pas une faute. */
export function rightsFaults(dataRoot: string, bookId: string | null, rights: string[], lenient = true): string[] {
  const registry = registryOf(dataRoot, bookId);
  return rights.flatMap((id) => {
    const e = registry.get(id);
    if (!e) return [`droit inconnu du registre : ${id}`];
    if (lenient && (IGNORED_WORKFLOW_KINDS as readonly string[]).includes(e.kind)) return [];
    if (!(WORKFLOW_RIGHTS_KINDS as readonly string[]).includes(e.kind)) return [`${id} : un workflow ne porte pas ce type de droit (${e.kind})${e.kind === 'image-reference' ? ', la référence vient du style' : ''}`];
    return [];
  });
}

/** Les droits d'un workflow qui passent à l'image : les droits ignorés en sont retirés. */
export const effectiveRights = (s: WorkflowState & { state: 'ok' }) => s.entry.rights.filter((id) => !s.ignored.includes(id));

function readOne(dir: string, entry: WorkflowEntry | undefined, kind: WorkflowKind, faultsOf: (rights: string[]) => string[], ignoredOf: (rights: string[]) => string[]): WorkflowState {
  if (!entry) return { state: 'absent' };
  const label = `collection/workflows/${entry.file}`;
  const refuse = (message: string): WorkflowState => ({ state: 'refuse', message, entry });
  if (!entry.file.startsWith(`${kind}.`)) return refuse(`${WORKFLOWS_INDEX} cite ${entry.file} pour la ${WORKFLOW_LABELS[kind]}.`);
  const file = path.join(dir, entry.file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return refuse(`${label} absent : le redéposer.`);
  if (!stat.isFile()) return refuse(`${label} n'est pas un fichier réel.`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== entry.sha256) return refuse(`${label} a changé depuis son dépôt (empreinte différente) : le redéposer dans la page.`);
  try {
    return { state: 'ok', entry, graph: parseGraph(bytes.toString('utf8'), kind), rightsFaults: faultsOf(entry.rights), ignored: ignoredOf(entry.rights) };
  } catch (e) {
    if (e instanceof WorkflowRefused) return refuse(e.message);
    throw e;
  }
}

export type Workflows = Record<WorkflowKind, WorkflowState>;

/** `bookId` : le registre du livre compte aussi pour les droits. `null` : registre commun seul. */
export function readWorkflows(dataRoot: string, bookId: string | null): Workflows {
  const dir = workflowsFolder(dataRoot, false);
  if (!dir) return { generation: { state: 'absent' }, agrandissement: { state: 'absent' } };
  const index = readIndex(dir);
  const faultsOf = (rights: string[]) => rightsFaults(dataRoot, bookId, rights);
  const ignoredOf = (rights: string[]) => ignoredRights(dataRoot, bookId, rights);
  return { generation: readOne(dir, index.generation, 'generation', faultsOf, ignoredOf), agrandissement: readOne(dir, index.agrandissement, 'agrandissement', faultsOf, ignoredOf) };
}

/** Les deux workflows sont prêts : valides, avec au moins un droit coché, tous connus. Sinon, les motifs. */
export function workflowsReady(w: Workflows): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const kind of WORKFLOW_KINDS) {
    const s = w[kind];
    const label = WORKFLOW_LABELS[kind];
    if (s.state === 'absent') reasons.push(`Déposer le workflow de ${label} (étape Workflows).`);
    else if (s.state === 'refuse') reasons.push(s.message);
    else if (s.rightsFaults.length > 0) reasons.push(`Workflow de ${label} : ${s.rightsFaults.join(' ; ')}.`);
    else if (effectiveRights(s).length === 0) reasons.push(`Workflow de ${label} : cocher ses droits (étape Workflows).`);
  }
  return { ready: reasons.length === 0, reasons };
}

const stampOf = (now: Date) => now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');

/** Dépose un workflow : contrôlé d'abord, écrit ensuite sous un nom daté, sans jamais écraser. Les droits du précédent sont gardés. */
export function depositWorkflow(dataRoot: string, bookId: string | null, kind: WorkflowKind, content: string, now: Date): { entry: WorkflowEntry; previous: string | null } {
  parseGraph(content, kind);
  const dir = workflowsFolder(dataRoot, true)!;
  const index = readIndex(dir);
  const bytes = Buffer.from(content, 'utf8');
  let name = `${kind}.${stampOf(now)}.json`;
  for (let i = 2; fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }); i++) name = `${kind}.${stampOf(now)}-${i}.json`;
  const fd = fs.openSync(path.join(dir, name), 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const previous = index[kind] ?? null;
  const registry = registryOf(dataRoot, bookId);
  const rights = previous ? previous.rights : SPECS[kind].defaultRights.filter((id) => registry.has(id));
  const entry: WorkflowEntry = { file: name, date: now.toISOString(), sha256: sha256(bytes), rights };
  writeAtomic(dir, WORKFLOWS_INDEX, json(indexSchema.parse({ ...index, [kind]: entry })));
  return { entry, previous: previous?.file ?? null };
}

export function setWorkflowRights(dataRoot: string, bookId: string | null, kind: WorkflowKind, rights: string[]): void {
  const dir = workflowsFolder(dataRoot, false);
  const index = dir ? readIndex(dir) : null;
  const entry = index?.[kind];
  if (!dir || !index || !entry) throw new WorkflowRefused(`Déposer d'abord le workflow de ${WORKFLOW_LABELS[kind]}.`);
  const unique = [...new Set(rights)];
  const faults = rightsFaults(dataRoot, bookId, unique, false);
  if (faults.length > 0) throw new WorkflowRefused(`Droits refusés : ${faults.join(' ; ')}.`);
  const next = indexSchema.parse({ ...index, [kind]: { ...entry, rights: unique } });
  if (JSON.stringify(next) !== JSON.stringify(index)) writeAtomic(dir, WORKFLOWS_INDEX, json(next));
}

/** Prompt positif du workflow de génération : prérempli dans la vue, tant que David ne l'a pas changé pour la zone. */
export const defaultPrompt = (w: Workflows): string | null => (w.generation.state === 'ok' ? String(fieldOf(w.generation.graph, '6', 'text')) : null);
/** Nom de la référence d'IL1 dans le dossier d'entrée de ComfyUI (nœud 22) : relue une fois, pour créer le style de base (IC2). */
export const referenceName = (w: Workflows): string | null => (w.generation.state === 'ok' ? String(fieldOf(w.generation.graph, '22', 'image')) : null);

export { graphFaults };
