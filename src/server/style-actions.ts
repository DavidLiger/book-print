// src/server/style-actions.ts — étape Styles du livre (IC2, spec §11.2) : bibliothèque, style de base, référence, rendu d'essai, aperçus et planche,
// style par défaut. Les aperçus passent par la file d'IC1 ; la seule sortie réseau reste ComfyUI, sur la boucle locale.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { parseComfyUrl } from '../comfy/address';
import { viewInput } from '../comfy/client';
import { runPreview, PREVIEW_SEED } from '../comfy/run';
import { defaultPrompt, readWorkflows, referenceName, workflowsReady } from '../comfy/workflow-file';
import { WorkflowRefused } from '../comfy/workflow';
import { readPrintBook } from '../data/pricing-file';
import { setDefaultStyle, SubjectRefused } from '../data/subject-file';
import { MAX_UPLOAD_BYTES } from '../images/clean';
import { readPngHeader } from '../images/png';
import { allEntries, ensureCollectionEntry, readBookRights, readCollectionRights } from '../rights/registry';
import { slugSchema } from '../schema/common';
import { cacheRoot, createStyle, referenceOnDisk, saveEssaiPrompt, saveStyle, storeEssaiInput, storeReference } from '../styles/files';
import { baseStyle } from '../styles/graph';
import { previewKey, referenceToCheck, styleFaults, styleRun } from '../styles/library';
import { ESSAI_INPUTS, ESSAI_SIZE, imageKind, okStyle, readEssai, readPreview, readStyle, readStyles, StyleRefused, type EssaiInput, type StyleState } from '../styles/read';
import { BASE_STYLE_ID, DRAWING_AUTHOR, drawingRightsId, STYLE_PROMPT_MAX, STYLE_TEXT_MAX, styleIdSchema, styleSchema, type Style } from '../styles/schema';
import type { ComfyRuntime } from './comfy-actions';
import type { Config } from './config';
import { receive, UploadTooLarge } from './illustration-actions';
import { reading } from './subject-actions';

export class BadStyleRequest extends Error {}

export const REFERENCE_ROUTE = '/api/styles/reference';
export const ESSAI_ROUTE = '/api/styles/essai';

type Json = Record<string, unknown>;

/** Ce que la page envoie : le style sans le nom du fichier de la référence, qui vient du disque, ni le droit d'un dessin, qui vient du style. */
const referenceInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('aucune') }),
  z.strictObject({ type: z.literal('dessin'), grayscale: z.boolean() }),
  z.strictObject({ type: z.literal('externe'), rights: slugSchema, grayscale: z.boolean() }),
]);
const styleInput = z.strictObject({
  name: z.string(),
  description: z.string(),
  prompt: z.string().max(STYLE_PROMPT_MAX),
  negative: z.string().max(STYLE_TEXT_MAX),
  denoise: z.number(),
  ipAdapterWeight: z.number(),
  controlnet: z.strictObject({
    depth: z.strictObject({ strength: z.number() }),
    canny: z.strictObject({ strength: z.number() }),
    tile: z.strictObject({ strength: z.number(), start: z.number(), end: z.number() }),
  }),
  colorDosage: z.number(),
  reference: referenceInput,
  upscale: z.strictObject({ prompt: z.string().max(STYLE_TEXT_MAX), negative: z.string().max(STYLE_TEXT_MAX) }),
});
type StyleInput = z.infer<typeof styleInput>;

const dirBody = z.strictObject({ dir: z.string() });
const styleBody = z.strictObject({ dir: z.string(), id: z.string(), style: styleInput });
const defaultBody = z.strictObject({ dir: z.string(), styleId: slugSchema.nullable() });
const promptBody = z.strictObject({ dir: z.string(), prompt: z.string().max(STYLE_TEXT_MAX) });
const previewsBody = z.strictObject({ dir: z.string(), ids: z.array(slugSchema).max(200).optional() });
const referenceQuery = z.strictObject({ dir: z.string(), id: slugSchema, t: z.string().optional() });
const essaiQuery = z.strictObject({ dir: z.string(), kind: z.enum(ESSAI_INPUTS), t: z.string().optional() });
const previewQuery = z.strictObject({ id: slugSchema, key: z.string().regex(/^[0-9a-f]{16}$/), t: z.string().optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadStyleRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

const registryOf = (config: Config, bookId: string) => allEntries(readCollectionRights(config.dataRoot), readBookRights(config.dataRoot, bookId));
const previewZoneKey = (id: string) => `styles/${id}`;

function comfyOrigin(config: Config): string {
  const address = parseComfyUrl(config.comfyUrl);
  if (!address.ok) throw new WorkflowRefused(address.message);
  return address.origin;
}

/** Le prompt du rendu d'essai : celui que David a réglé, sinon celui du workflow de génération. */
function essaiPrompt(config: Config, bookId: string): string {
  return readEssai(config.dataRoot).prompt ?? defaultPrompt(readWorkflows(config.dataRoot, bookId)) ?? '';
}

function previewOf(config: Config, bookId: string, s: StyleState & { state: 'ok' }): string | null {
  const workflows = readWorkflows(config.dataRoot, bookId);
  if (workflows.generation.state !== 'ok') return null;
  return previewKey(s, readEssai(config.dataRoot), essaiPrompt(config, bookId), workflows.generation.entry.sha256, PREVIEW_SEED);
}

function styleView(config: Config, bookId: string, s: StyleState, registry: ReturnType<typeof registryOf>, rt: ComfyRuntime): Json {
  const busy = rt.queue.busy(previewZoneKey(s.id)).includes('apercu');
  if (s.state !== 'ok') return { id: s.id, state: 'refuse', message: s.message, faults: [s.message], busy };
  const key = previewOf(config, bookId, s);
  const cached = key !== null && readPreview(config.dataRoot, s.id, key) !== null;
  return {
    id: s.id,
    state: 'ok',
    style: s.style,
    sha256: s.sha256,
    reference: s.reference && { file: s.reference.file, sha256: s.reference.sha256 },
    faults: styleFaults(s, registry),
    toCheck: referenceToCheck(s.style, registry),
    preview: key === null ? null : { key, cached },
    busy,
  };
}

function stylesState(config: Config, dir: string, rt: ComfyRuntime): Json {
  const { bookId } = reading(config, dir);
  const registry = registryOf(config, bookId);
  const styles = readStyles(config.dataRoot);
  const essai = readEssai(config.dataRoot);
  const workflows = readWorkflows(config.dataRoot, bookId);
  const { book, error } = readPrintBook(config.dataRoot, bookId);
  if (!book) throw new StyleRefused(error ?? `Dossier du livre absent : ${bookId}/.`);
  return {
    styles: styles.map((s) => styleView(config, bookId, s, registry, rt)),
    defaultStyle: book.defaultStyle ?? null,
    essai: {
      inputs: Object.fromEntries(ESSAI_INPUTS.map((k) => [k, essai.inputs[k].state === 'refuse' ? { state: 'refuse', message: (essai.inputs[k] as { message: string }).message } : { state: essai.inputs[k].state }])),
      prompt: essaiPrompt(config, bookId),
      promptIsDefault: essai.prompt === null,
      promptError: essai.promptError,
      size: ESSAI_SIZE,
    },
    workflows: workflowsReady(workflows),
    canCreateBase: !styles.some((s) => s.id === BASE_STYLE_ID),
    references: [...registry.values()].filter((e) => e.kind === 'image-reference').map(({ id, name, author, license, commercialOk }) => ({ id, name, author, license, commercialOk })),
    seed: PREVIEW_SEED,
  };
}

/** Style de la page vers `style.json` : le fichier de la référence vient du disque, le droit d'un dessin vient de l'identifiant du style. */
function toStyle(config: Config, bookId: string, id: string, input: StyleInput, exists: boolean): Style {
  const registry = registryOf(config, bookId);
  const file = exists ? referenceOnDisk(config.dataRoot, id) : null;
  let reference: Style['reference'];
  if (input.reference.type === 'aucune') reference = { type: 'aucune' };
  else if (input.reference.type === 'dessin') reference = { type: 'dessin', rights: drawingRightsId(id), file, grayscale: input.reference.grayscale };
  else {
    const e = registry.get(input.reference.rights);
    if (!e || e.kind !== 'image-reference') throw new StyleRefused(`Référence externe : choisir une image de référence du registre (${input.reference.rights} n'en est pas une).`);
    if (e.commercialOk === 'non') throw new StyleRefused(`Référence externe refusée : ${e.name} n'admet pas l'usage commercial.`);
    reference = { type: 'externe', rights: e.id, file, grayscale: input.reference.grayscale };
  }
  const parsed = styleSchema.safeParse({ schemaVersion: 1, ...input, reference });
  if (!parsed.success) throw new StyleRefused(`Style refusé : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}.`);
  return parsed.data;
}

/** Entrée `image-reference` d'un dessin de David, au registre commun, sans écraser une entrée existante (question 5). */
function ensureDrawingEntry(config: Config, bookId: string, id: string, style: Style): boolean {
  if (style.reference.type !== 'dessin') return false;
  return ensureCollectionEntry(config.dataRoot, bookId, {
    id: drawingRightsId(id),
    kind: 'image-reference',
    name: `Dessin de ${DRAWING_AUTHOR}, référence du style « ${style.name} »`,
    author: DRAWING_AUTHOR,
    license: 'Œuvre de l\'auteur, droits de l\'auteur',
    credit: `Référence de style : dessin de ${DRAWING_AUTHOR}.`,
    commercialOk: 'oui',
  });
}

function create(config: Config, value: z.infer<typeof styleBody>, rt: ComfyRuntime): Json {
  const { dir, id, style } = value;
  const { bookId } = reading(config, dir);
  if (!styleIdSchema.safeParse(id).success) throw new StyleRefused(`Identifiant de style refusé : ${id} (minuscules, chiffres et tirets, 40 caractères au plus).`);
  if (readStyles(config.dataRoot).some((s) => s.id === id)) throw new StyleRefused(`Le style ${id} existe déjà : rien n'est écrasé.`);
  const checked = toStyle(config, bookId, id, style, false);
  createStyle(config.dataRoot, id, checked);
  const entry = ensureDrawingEntry(config, bookId, id, checked);
  return { created: id, entry: entry ? drawingRightsId(id) : null, ...stylesState(config, dir, rt) };
}

function save(config: Config, value: z.infer<typeof styleBody>, rt: ComfyRuntime): Json {
  const { dir, id, style } = value;
  const { bookId } = reading(config, dir);
  const s = readStyle(config.dataRoot, id);
  if (s.state !== 'ok') throw new StyleRefused(`${s.message} Le corriger dans le fichier : l'outil ne le réécrit pas.`);
  const checked = toStyle(config, bookId, id, style, true);
  saveStyle(config.dataRoot, id, checked);
  const entry = ensureDrawingEntry(config, bookId, id, checked);
  return { saved: id, entry: entry ? drawingRightsId(id) : null, ...stylesState(config, dir, rt) };
}

/** Style de base (question 2) : les valeurs des workflows, la référence du nœud 22 relue dans ComfyUI, rattachée à `niedot294a`. N'écrase rien. */
async function createBase(config: Config, dir: string, rt: ComfyRuntime): Promise<Json> {
  const { bookId } = reading(config, dir);
  if (readStyles(config.dataRoot).some((s) => s.id === BASE_STYLE_ID)) throw new StyleRefused('Le style de base existe déjà : rien n\'est écrasé.');
  const workflows = readWorkflows(config.dataRoot, bookId);
  if (workflows.generation.state !== 'ok' || workflows.agrandissement.state !== 'ok') throw new WorkflowRefused(`Déposer d'abord les deux workflows (étape Workflows). ${workflowsReady(workflows).reasons.join(' ')}`);
  const rights = 'niedot294a';
  const entry = registryOf(config, bookId).get(rights);
  if (!entry || entry.kind !== 'image-reference') throw new StyleRefused(`${rights} absent du registre : l'ajouter d'abord (étape Droits, « Ajouter ce qui manque »).`);
  const name = referenceName(workflows)!;
  const { bytes } = await viewInput(rt.deps.client(comfyOrigin(config)), name);
  createStyle(config.dataRoot, BASE_STYLE_ID, baseStyle(workflows.generation.graph, workflows.agrandissement.graph, rights, null));
  storeReference(config.dataRoot, BASE_STYLE_ID, bytes);
  return { created: BASE_STYLE_ID, reference: name, ...stylesState(config, dir, rt) };
}

function changeDefault(config: Config, value: z.infer<typeof defaultBody>, rt: ComfyRuntime): Json {
  const { dir, styleId } = value;
  const { bookId } = reading(config, dir);
  if (styleId !== null && !readStyles(config.dataRoot).some((s) => s.id === styleId)) throw new StyleRefused(`Style inconnu de la bibliothèque : ${styleId}.`);
  setDefaultStyle(config.dataRoot, bookId, styleId);
  return stylesState(config, dir, rt);
}

/** Met en file l'aperçu des styles demandés, ou de tous ceux qui manquent (la planche). Un aperçu en cache ou déjà dans la file n'est pas refait. */
function queuePreviews(config: Config, value: z.infer<typeof previewsBody>, rt: ComfyRuntime): Json {
  const { dir, ids } = value;
  const { bookId } = reading(config, dir);
  const workflows = readWorkflows(config.dataRoot, bookId);
  if (workflows.generation.state !== 'ok' || !workflowsReady(workflows).ready) throw new WorkflowRefused(workflowsReady(workflows).reasons.join(' ') || 'Workflow de génération à déposer.');
  const essai = readEssai(config.dataRoot);
  const { rendu, mist } = essai.inputs;
  if (rendu.state !== 'ok' || mist.state !== 'ok') throw new StyleRefused(`Déposer d'abord le rendu d'essai et sa Mist, en ${ESSAI_SIZE.width} × ${ESSAI_SIZE.height} px.`);
  const address = comfyOrigin(config);
  const registry = registryOf(config, bookId);
  const prompt = essaiPrompt(config, bookId);
  const queued: string[] = [];
  const skipped: string[] = [];
  for (const s of readStyles(config.dataRoot)) {
    if (ids && !ids.includes(s.id)) continue;
    const ok = okStyle(s);
    if (!ok || styleFaults(s, registry).length > 0) {
      skipped.push(s.id);
      continue;
    }
    const key = previewKey(ok, essai, prompt, workflows.generation.entry.sha256, PREVIEW_SEED)!;
    if (readPreview(config.dataRoot, s.id, key) || rt.queue.busy(previewZoneKey(s.id)).includes('apercu')) continue;
    const job = { dataRoot: config.dataRoot, origin: address, key, prompt, rendu: fs.readFileSync(rendu.path), mist: fs.readFileSync(mist.path), workflow: { entry: workflows.generation.entry, graph: workflows.generation.graph }, style: styleRun(config.dataRoot, s.id, registry) };
    rt.queue.add({ kind: 'apercu', zoneKey: previewZoneKey(s.id), label: `aperçu du style ${ok.style.name}`, run: (c) => runPreview(job, c, rt.deps) });
    queued.push(s.id);
  }
  return { queued, skipped, ...stylesState(config, dir, rt) };
}

export function styleActions(rt: ComfyRuntime): Record<string, (body: unknown, config: Config) => Json | Promise<Json>> {
  return {
    '/api/styles/state': (body, config) => stylesState(config, parse(dirBody, body).dir, rt),
    '/api/styles/base': (body, config) => createBase(config, parse(dirBody, body).dir, rt),
    '/api/styles/creer': (body, config) => create(config, parse(styleBody, body), rt),
    '/api/styles/enregistrer': (body, config) => save(config, parse(styleBody, body), rt),
    '/api/styles/defaut': (body, config) => changeDefault(config, parse(defaultBody, body), rt),
    '/api/styles/essai-prompt': (body, config) => {
      const { dir, prompt } = parse(promptBody, body);
      reading(config, dir);
      saveEssaiPrompt(config.dataRoot, prompt);
      return stylesState(config, dir, rt);
    },
    '/api/styles/apercus': (body, config) => queuePreviews(config, parse(previewsBody, body), rt),
  };
}

let depositing = false;

/** Dépôt binaire, en flux dans un temporaire de `collection/.cache/`, hors git : une coupure n'y laisse rien de suivi. */
async function receiveImage(req: http.IncomingMessage, config: Config, run: (bytes: Buffer) => Json): Promise<Json> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`Fichier trop gros : ${MAX_UPLOAD_BYTES / (1024 * 1024)} Mio au plus.`);
  if (depositing) throw new StyleRefused('Un dépôt est déjà en cours.');
  depositing = true;
  let tmp: string | null = null;
  try {
    tmp = path.join(cacheRoot(config.dataRoot), `style.${crypto.randomBytes(6).toString('hex')}.depot.tmp`);
    await receive(req, tmp);
    return run(fs.readFileSync(tmp));
  } finally {
    depositing = false;
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

/** Référence d'un style : PNG ou JPEG, rangée telle quelle (question 5). Le style doit attendre une référence. */
export async function depositReference(query: URLSearchParams, req: http.IncomingMessage, config: Config, rt: ComfyRuntime): Promise<Json> {
  const { dir, id } = parse(referenceQuery, Object.fromEntries(query));
  reading(config, dir);
  const s = readStyle(config.dataRoot, id);
  if (s.state !== 'ok') throw new StyleRefused(s.message);
  if (s.style.reference.type === 'aucune') throw new StyleRefused(`Le style ${s.style.name} n'a pas de référence : choisir d'abord « dessin de David » ou « image externe », puis enregistrer.`);
  return receiveImage(req, config, (bytes) => {
    const kind = imageKind(bytes);
    if (!kind) throw new StyleRefused('Référence refusée : ce fichier n\'est ni un PNG ni un JPEG.');
    storeReference(config.dataRoot, id, bytes);
    return { deposited: { id, kind }, ...stylesState(config, dir, rt) };
  });
}

/** Rendu ou Mist d'essai, en 832 × 1216 : gardé tel quel, comme les entrées d'IC1. Les aperçus en cache tombent avec la clé. */
export async function depositEssai(query: URLSearchParams, req: http.IncomingMessage, config: Config, rt: ComfyRuntime): Promise<Json> {
  const { dir, kind } = parse(essaiQuery, Object.fromEntries(query));
  reading(config, dir);
  return receiveImage(req, config, (bytes) => {
    const header = readPngHeader(bytes);
    if (!header) throw new StyleRefused('Ce fichier n\'est pas un PNG.');
    if (header.width !== ESSAI_SIZE.width || header.height !== ESSAI_SIZE.height) {
      throw new StyleRefused(`${kind === 'rendu' ? 'Rendu' : 'Passe Mist'} d'essai en ${header.width} × ${header.height} px : ${ESSAI_SIZE.width} × ${ESSAI_SIZE.height} attendus (page pleine en 6 × 9").`);
    }
    storeEssaiInput(config.dataRoot, kind as EssaiInput, bytes);
    return { deposited: { kind }, ...stylesState(config, dir, rt) };
  });
}

/** Aperçu d'un style, lu dans le cache. Lecture seule ; le nom vient de l'identifiant et de la clé. */
export function previewBytes(query: URLSearchParams, config: Config): Buffer {
  const { id, key } = parse(previewQuery, Object.fromEntries(query));
  const bytes = readPreview(config.dataRoot, id, key);
  if (!bytes) throw new SubjectRefused(`Aucun aperçu en cache pour le style ${id}.`);
  return bytes;
}
