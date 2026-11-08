// src/server/comfy-actions.ts — pilotage de ComfyUI (IC1) : état et file, étape Workflows, vue « Générer » de l'étape Illustrations. La seule sortie
// réseau ajoutée va vers ComfyUI, sur la boucle locale (`src/comfy/address.ts`). La file vit dans le serveur : un redémarrage la perd.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { parseComfyUrl } from '../comfy/address';
import { checkLauncher, launch as launchComfyUi } from '../comfy/launcher';
import { ComfyError } from '../comfy/client';
import { cacheImage, clearCandidates, correctedName, inputFile, inputName, INPUT_KINDS, readCandidates, type InputKind } from '../comfy/files';
import { colorWords } from '../comfy/prompt';
import { QueueRefused, TaskQueue, type QueueSnapshot } from '../comfy/queue';
import { defaultRunDeps, runGeneration, runUpscale, type RunDeps } from '../comfy/run';
import { outputPixels, renderSize, sizeText, zoneKind, ZONE_KIND_LABELS } from '../comfy/size';
import { defaultPrompt, depositWorkflow, effectiveRights, readWorkflows, setWorkflowRights, workflowsReady, type Workflows, type WorkflowState } from '../comfy/workflow-file';
import { SPECS, WORKFLOW_KINDS, WORKFLOW_LABELS, WORKFLOW_RIGHTS_KINDS, WorkflowRefused } from '../comfy/workflow';
import { illustrationFile, illustrationFolder } from '../data/illustration-file';
import { SubjectRefused, updateSubject } from '../data/subject-file';
import { ImageRefused, MAX_UPLOAD_BYTES } from '../images/clean';
import { readPngHeaderOfFile } from '../images/png';
import { zoneImages, type SubjectContext } from '../render/subject';
import { allEntries, readBookRights, readCollectionRights } from '../rights/registry';
import { slugSchema } from '../schema/common';
import { GENERATION_PROMPT_MAX } from '../schema/subject';
import { styleFaults, styleRun, zoneStyleId } from '../styles/library';
import { readStyles, StyleRefused } from '../styles/read';
import type { Config } from './config';
import { context, receive, requireZone, UploadTooLarge } from './illustration-actions';
import { reading } from './subject-actions';

export class BadComfyRequest extends Error {}

export const ENTRY_ROUTE = '/api/sujet/entree';
/** Un workflow au format API fait quelques Ko : la limite de l'import de recherche suffit largement. */
export const WORKFLOW_MAX_BYTES = 2 * 1024 * 1024;
/** Graines par « Générer » (§11.1). */
export const SEEDS_PER_RUN = 3;

type Json = Record<string, unknown>;

export interface ComfyRuntime {
  queue: TaskQueue;
  deps: RunDeps;
  /** Graine au hasard : remplaçable dans les tests. */
  seed: () => number;
  /** Ouvre le lanceur de ComfyUI : remplaçable dans les tests. */
  launch: (file: string) => void;
  /** Dernier lancement demandé, en ms. */
  launchedAt: number | null;
}

/** Après un lancement, un autre est refusé pendant ce délai : ComfyUI met jusqu'à une minute à répondre. */
export const LAUNCH_GUARD_MS = 120_000;

export const createComfyRuntime = (deps: Partial<RunDeps> = {}, seed?: () => number, launch?: (file: string) => void): ComfyRuntime => ({
  queue: new TaskQueue(),
  deps: { ...defaultRunDeps(), ...deps },
  seed: seed ?? (() => crypto.randomInt(1, 2 ** 32)),
  launch: launch ?? launchComfyUi,
  launchedAt: null,
});

const kindSchema = z.enum(WORKFLOW_KINDS);
const stateBody = z.strictObject({ ping: z.boolean().optional() });
const wfStateBody = z.strictObject({ dir: z.string() });
const wfDepositBody = z.strictObject({ dir: z.string(), kind: kindSchema, content: z.string() });
const wfRightsBody = z.strictObject({ dir: z.string(), kind: kindSchema, rights: z.array(slugSchema) });
const subjectBody = z.strictObject({ dir: z.string(), subjectId: slugSchema });
const zoneBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema });
/** `seed` (IC2, question 11) : une seule image, de cette graine, au lieu de trois au hasard. */
const launchBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, seed: z.number().int().nonnegative().max(2 ** 53 - 1).optional() });
/** `styleId: null` : la zone revient au style par défaut du livre. */
const zoneStyleBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, styleId: slugSchema.nullable() });
const promptBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, text: z.string().max(GENERATION_PROMPT_MAX) });
const upscaleBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, seed: z.number().int().nonnegative(), confirm: z.boolean().optional() });
const cancelBody = z.strictObject({ id: z.number().int().positive() });
const entryQuery = z.strictObject({ dir: z.string(), subject: slugSchema, zone: slugSchema, kind: z.enum(INPUT_KINDS), t: z.string().optional() });
const candidateQuery = z.strictObject({ dir: z.string(), subject: slugSchema, zone: slugSchema, seed: z.string().regex(/^\d{1,12}$/), t: z.string().optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadComfyRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

const zoneKeyOf = (bookId: string, subjectId: string, zone: string) => `${bookId}/${subjectId}/${zone}`;

function origin(config: Config): string {
  const address = parseComfyUrl(config.comfyUrl);
  if (!address.ok) throw new WorkflowRefused(address.message);
  return address.origin;
}

// État de ComfyUI et file

export async function comfyState(config: Config, queue: QueueSnapshot, ping: boolean, rt: ComfyRuntime): Promise<Json> {
  const address = parseComfyUrl(config.comfyUrl);
  let server: Json | null = null;
  if (ping && address.ok) {
    try {
      server = { ok: true, ...(await rt.deps.client(address.origin).systemStats()) };
    } catch (e) {
      if (!(e instanceof ComfyError)) throw e;
      server = { ok: false, error: e.message };
    }
  }
  const l = checkLauncher(config.comfyLauncher);
  const launcher = l.state === 'ok' ? { state: 'ok', file: l.file } : l.state === 'refuse' ? { state: 'refuse', message: l.message } : { state: 'absent' };
  const starting = rt.launchedAt !== null && rt.deps.now().getTime() - rt.launchedAt < LAUNCH_GUARD_MS;
  return { address: address.ok ? { ok: true, url: address.origin } : { ok: false, error: address.message }, server, queue, launcher, starting };
}

/** « Lancer ComfyUI » : seulement s'il ne répond pas, avec le lanceur de `config.local.json`, une fois par `LAUNCH_GUARD_MS`. */
async function launchComfy(config: Config, rt: ComfyRuntime): Promise<Json> {
  const l = checkLauncher(config.comfyLauncher);
  if (l.state === 'absent') throw new WorkflowRefused('Aucun lanceur : ajouter "comfyLauncher": "D:/IA/ComfyUI/run_il0.bat" dans config.local.json, ou lancer ComfyUI à la main.');
  if (l.state === 'refuse') throw new WorkflowRefused(l.message);
  const address = origin(config);
  const now = rt.deps.now().getTime();
  if (rt.launchedAt !== null && now - rt.launchedAt < LAUNCH_GUARD_MS) throw new WorkflowRefused('Lancement déjà demandé : ComfyUI démarre dans sa fenêtre, attendre qu\'il réponde.');
  const up = await rt.deps.client(address).systemStats().then(() => true, (e: unknown) => {
    if (e instanceof ComfyError) return false;
    throw e;
  });
  if (up) throw new WorkflowRefused('ComfyUI répond déjà : rien n\'est lancé.');
  rt.launch(l.file);
  rt.launchedAt = now;
  return { launched: l.file, ...(await comfyState(config, rt.queue.snapshot(), false, rt)) };
}

// Workflows (étape du livre)

function workflowView(s: WorkflowState): Json {
  if (s.state === 'absent') return { state: 'absent' };
  if (s.state === 'refuse') return { state: 'refuse', message: s.message, file: s.entry?.file ?? null, rights: s.entry?.rights ?? [] };
  return { state: 'ok', file: s.entry.file, date: s.entry.date, sha256: s.entry.sha256, rights: effectiveRights(s), rightsFaults: s.rightsFaults, ignored: s.ignored };
}

function workflowsState(config: Config, dir: string): Json {
  const { bookId } = reading(config, dir);
  const workflows = readWorkflows(config.dataRoot, bookId);
  const registry = allEntries(readCollectionRights(config.dataRoot), readBookRights(config.dataRoot, bookId));
  const entries = [...registry.values()].filter((e) => (WORKFLOW_RIGHTS_KINDS as readonly string[]).includes(e.kind)).map(({ id, kind, name, author, license, commercialOk }) => ({ id, kind, name, author, license, commercialOk }));
  // Les droits ignorés (IC2) sont nommés : `workflows.json` n'est pas réécrit sans action de David.
  const checked = Object.fromEntries(WORKFLOW_KINDS.map((k) => [k, Object.entries(SPECS[k].nodes).map(([id, n]) => `${id} ${n.classType}`)]));
  return { kinds: Object.fromEntries(WORKFLOW_KINDS.map((k) => [k, workflowView(workflows[k])])), ready: workflowsReady(workflows), entries, checked };
}

// Génération (vue « Générer » de l'étape Illustrations)

type Registry = ReturnType<typeof allEntries>;
const registryOf = (ctx: SubjectContext): Registry => allEntries(ctx.collection.rights, readBookRights(ctx.dataRoot, ctx.book.bookId));

/** Les styles proposés dans la vue « Générer » : tous, avec ce qui empêche de générer. */
function stylesView(ctx: SubjectContext, registry: Registry): Json[] {
  return readStyles(ctx.dataRoot).map((s) => ({ id: s.id, name: s.state === 'ok' ? s.style.name : s.id, faults: styleFaults(s, registry) }));
}

function zoneView(ctx: SubjectContext, workflows: Workflows, rt: ComfyRuntime, styles: Json[]): Json[] {
  const { dataRoot, book, subject } = ctx;
  const fallback = defaultPrompt(workflows);
  return zoneImages(ctx).map((z) => {
    const kind = zoneKind(z.size, ctx.trim);
    const render = kind ? renderSize(ctx.trim, kind) : null;
    const reason = !kind
      ? `La zone ${z.zone} n'est ni une page pleine ni une double page : pas de génération, déposer l'image à la main.`
      : !render
        ? `Le format ${ctx.trim.widthIn} × ${ctx.trim.heightIn}" n'a pas de taille de rendu retenue (§13.2) : pas de génération.`
        : null;
    const inputs = Object.fromEntries(
      INPUT_KINDS.map((k) => {
        const f = inputFile(dataRoot, book.bookId, subject.id, z.zone, k);
        if (f.state !== 'ok') return [k, { state: f.state, name: inputName(z.zone, k), message: f.state === 'refuse' ? f.message : null }];
        const size = { width: f.header.width, height: f.header.height };
        const fits = render !== null && size.width === render.width && size.height === render.height;
        return [k, { state: fits ? 'ok' : 'refuse', name: inputName(z.zone, k), size, message: fits ? null : `${inputName(z.zone, k)} en ${sizeText(size)}, ${render ? sizeText(render) : '?'} attendus : le redéposer.` }];
      }),
    );
    const prompt = subject.generationPrompts?.[z.zone] ?? fallback ?? '';
    const candidates = readCandidates(dataRoot, book.bookId, subject.id, z.zone);
    const styleId = zoneStyleId(book, subject, z.zone);
    const style = styles.find((x) => x.id === styleId) as { id: string; name: string; faults: string[] } | undefined;
    const styleReason = styleId === null
      ? 'Aucun style : choisir le style par défaut du livre (étape Styles), ou un style pour cette zone.'
      : !style ? `Style inconnu de la bibliothèque : ${styleId}.` : style.faults.length > 0 ? style.faults.join(' ') : null;
    return {
      zone: z.zone,
      kind,
      kindLabel: kind ? ZONE_KIND_LABELS[kind] : null,
      reason,
      render,
      output: outputPixels(z.size),
      target: z.target,
      inputs,
      prompt,
      promptIsDefault: subject.generationPrompts?.[z.zone] === undefined,
      colors: colorWords(prompt),
      // L'alerte de couleur porte aussi sur le prompt de style (question 3).
      styleColors: colorWords(style ? stylePromptOf(dataRoot, style.id) : ''),
      style: { id: styleId, chosen: subject.generationStyles?.[z.zone] !== undefined, name: style?.name ?? styleId, reason: styleReason },
      candidates: candidates && { date: candidates.date, seeds: candidates.candidates.map((c) => c.seed), comfyuiVersion: candidates.comfyuiVersion, style: candidates.style.id },
      hasImage: z.illustration !== null,
      busy: rt.queue.busy(zoneKeyOf(book.bookId, subject.id, z.zone)),
    };
  });
}

const stylePromptOf = (dataRoot: string, id: string): string => {
  const s = readStyles(dataRoot).find((x) => x.id === id);
  return s?.state === 'ok' ? s.style.prompt : '';
};

function generateState(config: Config, dir: string, subjectId: string, rt: ComfyRuntime): Json {
  const ctx = context(config, dir, subjectId);
  const workflows = readWorkflows(config.dataRoot, ctx.book.bookId);
  const styles = stylesView(ctx, registryOf(ctx));
  return { workflows: workflowsReady(workflows), zones: zoneView(ctx, workflows, rt, styles), trim: ctx.trim, styles, defaultStyle: ctx.book.defaultStyle ?? null };
}

/** Style d'une zone (question 7) : un style de la bibliothèque, ou `null` pour revenir au style par défaut du livre. */
function changeZoneStyle(config: Config, value: z.infer<typeof zoneStyleBody>, rt: ComfyRuntime): Json {
  const { dir, subjectId, zone, styleId } = value;
  const ctx = context(config, dir, subjectId);
  requireZone(ctx, zone);
  if (styleId !== null && !readStyles(config.dataRoot).some((s) => s.id === styleId)) throw new StyleRefused(`Style inconnu de la bibliothèque : ${styleId}.`);
  updateSubject(config.dataRoot, ctx.book.bookId, subjectId, (data) => {
    const styles = { ...(data.subject.generationStyles ?? {}) };
    if (styleId === null) delete styles[zone];
    else styles[zone] = styleId;
    const { generationStyles: _old, ...rest } = data.subject;
    return { ...data, subject: Object.keys(styles).length > 0 ? { ...rest, generationStyles: styles } : rest };
  });
  return generateState(config, dir, subjectId, rt);
}

function changePrompt(config: Config, value: z.infer<typeof promptBody>, rt: ComfyRuntime): Json {
  const { dir, subjectId, zone, text } = value;
  const ctx = context(config, dir, subjectId);
  requireZone(ctx, zone);
  const fallback = defaultPrompt(readWorkflows(config.dataRoot, ctx.book.bookId));
  updateSubject(config.dataRoot, ctx.book.bookId, subjectId, (data) => {
    const prompts = { ...(data.subject.generationPrompts ?? {}) };
    // Un prompt revenu à celui du workflow n'est plus une surcharge.
    if (text === fallback) delete prompts[zone];
    else prompts[zone] = text;
    const { generationPrompts: _old, ...rest } = data.subject;
    return { ...data, subject: Object.keys(prompts).length > 0 ? { ...rest, generationPrompts: prompts } : rest };
  });
  return generateState(config, dir, subjectId, rt);
}

/** Zone prête à générer : type, format, entrées aux tailles du §13.2. Rend ce que la tâche emporte. */
function generationInputs(ctx: SubjectContext, zone: string) {
  const z = zoneImages(ctx).find((i) => i.zone === zone)!;
  const kind = zoneKind(z.size, ctx.trim);
  if (!kind) throw new SubjectRefused(`La zone ${zone} n'est ni une page pleine ni une double page : pas de génération.`);
  const render = renderSize(ctx.trim, kind);
  if (!render) throw new SubjectRefused(`Le format ${ctx.trim.widthIn} × ${ctx.trim.heightIn}" n'a pas de taille de rendu retenue (§13.2).`);
  const files = INPUT_KINDS.map((k) => {
    const f = inputFile(ctx.dataRoot, ctx.book.bookId, ctx.subject.id, zone, k);
    if (f.state !== 'ok') throw new SubjectRefused(f.state === 'refuse' ? f.message : `Déposer d'abord ${k === 'rendu' ? 'le rendu' : 'la passe Mist'} (${inputName(zone, k)}).`);
    if (f.header.width !== render.width || f.header.height !== render.height) throw new SubjectRefused(`${inputName(zone, k)} en ${f.header.width} × ${f.header.height} px, ${sizeText(render)} attendus.`);
    return fs.readFileSync(f.path);
  });
  return { z, render, rendu: files[0]!, mist: files[1]! };
}

function readyWorkflows(config: Config, bookId: string) {
  const workflows = readWorkflows(config.dataRoot, bookId);
  const ready = workflowsReady(workflows);
  if (!ready.ready || workflows.generation.state !== 'ok' || workflows.agrandissement.state !== 'ok') throw new WorkflowRefused(ready.reasons.join(' '));
  return { generation: workflows.generation, agrandissement: workflows.agrandissement, workflows };
}

function launch(config: Config, value: z.infer<typeof launchBody>, rt: ComfyRuntime): Json {
  const { dir, subjectId, zone } = value;
  const ctx = context(config, dir, subjectId);
  requireZone(ctx, zone);
  const address = origin(config);
  const { generation, workflows } = readyWorkflows(config, ctx.book.bookId);
  const { render, rendu, mist } = generationInputs(ctx, zone);
  const styleId = zoneStyleId(ctx.book, ctx.subject, zone);
  if (styleId === null) throw new StyleRefused('Aucun style : choisir le style par défaut du livre (étape Styles), ou un style pour cette zone.');
  const style = styleRun(config.dataRoot, styleId, registryOf(ctx));
  const seeds = new Set<number>(value.seed !== undefined ? [value.seed] : []);
  while (seeds.size < (value.seed !== undefined ? 1 : SEEDS_PER_RUN)) seeds.add(rt.seed());
  const prompt = ctx.subject.generationPrompts?.[zone] ?? defaultPrompt(workflows)!;
  const job = {
    dataRoot: config.dataRoot, bookId: ctx.book.bookId, subjectId, zone, origin: address, prompt, seeds: [...seeds], rendu, mist, renderSize: render,
    workflow: { entry: generation.entry, graph: generation.graph }, style,
  };
  const task = rt.queue.add({ kind: 'generation', zoneKey: zoneKeyOf(ctx.book.bookId, subjectId, zone), label: `génération ${subjectId}/${zone}, style ${style.style.name}`, run: (c) => runGeneration(job, c, rt.deps) });
  return { task, ...generateState(config, dir, subjectId, rt) };
}

function upscale(config: Config, value: z.infer<typeof upscaleBody>, rt: ComfyRuntime): Json {
  const { dir, subjectId, zone, seed, confirm } = value;
  const ctx = context(config, dir, subjectId);
  requireZone(ctx, zone);
  const bookId = ctx.book.bookId;
  const address = origin(config);
  const { generation, agrandissement } = readyWorkflows(config, bookId);
  const candidates = readCandidates(config.dataRoot, bookId, subjectId, zone);
  if (!candidates?.candidates.some((c) => c.seed === seed)) throw new SubjectRefused(`Aucun candidat de graine ${seed} pour cette zone : relancer « Générer ».`);
  const corrected = cacheImage(config.dataRoot, bookId, subjectId, zone, correctedName(seed));
  if (!corrected) throw new SubjectRefused(`Image corrigée de la graine ${seed} absente du cache : relancer « Générer ».`);
  const z = zoneImages(ctx).find((i) => i.zone === zone)!;
  // La confirmation vient avant le calcul : deux minutes plus tard, il serait trop tard pour annuler.
  const exists = illustrationFile(config.dataRoot, bookId, subjectId, zone).state !== 'absent';
  if ((exists || z.illustration) && !confirm) return { needsConfirm: true };
  const registry = registryOf(ctx);
  const models3d = (z.rights ?? []).filter((id) => registry.get(id)?.kind === 'modele-3d');
  // La référence vient du style tracé avec les candidats, plus du workflow (question 6).
  const rights = [...new Set([...models3d, ...effectiveRights(generation), ...effectiveRights(agrandissement), ...(candidates.style.rights ? [candidates.style.rights] : [])])];
  const job = {
    dataRoot: config.dataRoot, bookId, subjectId, zone, origin: address, seed, corrected, candidates, output: outputPixels(z.size),
    workflows: { generation: generation.entry, agrandissement: { entry: agrandissement.entry, graph: agrandissement.graph } }, rights,
  };
  const task = rt.queue.add({ kind: 'agrandissement', zoneKey: zoneKeyOf(bookId, subjectId, zone), label: `agrandissement ${subjectId}/${zone}, graine ${seed}`, run: (c) => runUpscale(job, c, rt.deps) });
  return { task, ...generateState(config, dir, subjectId, rt) };
}

export function comfyActions(rt: ComfyRuntime): Record<string, (body: unknown, config: Config) => Json | Promise<Json>> {
  return {
    '/api/comfy/state': (body, config) => comfyState(config, rt.queue.snapshot(), parse(stateBody, body).ping ?? false, rt),
    '/api/comfy/lancer': (body, config) => {
      parse(z.strictObject({}), body);
      return launchComfy(config, rt);
    },
    '/api/comfy/annuler': (body) => {
      rt.queue.cancel(parse(cancelBody, body).id);
      return { queue: rt.queue.snapshot() };
    },
    '/api/workflows/state': (body, config) => workflowsState(config, parse(wfStateBody, body).dir),
    '/api/workflows/depot': (body, config) => {
      const { dir, kind, content } = parse(wfDepositBody, body);
      const { bookId } = reading(config, dir);
      const deposited = depositWorkflow(config.dataRoot, bookId, kind, content, rt.deps.now());
      return { deposited: { kind, label: WORKFLOW_LABELS[kind], ...deposited }, ...workflowsState(config, dir) };
    },
    '/api/workflows/droits': (body, config) => {
      const { dir, kind, rights } = parse(wfRightsBody, body);
      setWorkflowRights(config.dataRoot, reading(config, dir).bookId, kind, rights);
      return workflowsState(config, dir);
    },
    '/api/generer/state': (body, config) => {
      const { dir, subjectId } = parse(subjectBody, body);
      return generateState(config, dir, subjectId, rt);
    },
    '/api/generer/prompt': (body, config) => changePrompt(config, parse(promptBody, body), rt),
    '/api/generer/lancer': (body, config) => launch(config, parse(launchBody, body), rt),
    '/api/generer/style': (body, config) => changeZoneStyle(config, parse(zoneStyleBody, body), rt),
    '/api/generer/agrandir': (body, config) => upscale(config, parse(upscaleBody, body), rt),
  };
}

let depositing = false;

/** Rendu ou Mist : gardé tel quel, hors git, sans nettoyage. Seules la signature et la taille du §13.2 sont contrôlées. Les candidats de la zone tombent. */
export async function depositEntry(query: URLSearchParams, req: http.IncomingMessage, config: Config, rt: ComfyRuntime): Promise<Json> {
  const { dir, subject, zone, kind } = parse(entryQuery, Object.fromEntries(query));
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`Fichier trop gros : ${MAX_UPLOAD_BYTES / (1024 * 1024)} Mio au plus.`);
  if (depositing) throw new ImageRefused('Un dépôt est déjà en cours.');
  depositing = true;
  let tmp: string | null = null;
  try {
    const ctx = context(config, dir, subject);
    requireZone(ctx, zone);
    const bookId = ctx.book.bookId;
    if (rt.queue.busy(zoneKeyOf(bookId, subject, zone)).includes('generation')) throw new SubjectRefused('Une génération de cette zone est dans la file : attendre sa fin pour changer ses entrées.');
    const z = zoneImages(ctx).find((i) => i.zone === zone)!;
    const zk = zoneKind(z.size, ctx.trim);
    if (!zk) throw new SubjectRefused(`La zone ${zone} n'est ni une page pleine ni une double page : pas de génération.`);
    const render = renderSize(ctx.trim, zk);
    if (!render) throw new SubjectRefused(`Le format ${ctx.trim.widthIn} × ${ctx.trim.heightIn}" n'a pas de taille de rendu retenue (§13.2).`);
    const folder = illustrationFolder(config.dataRoot, bookId, subject, true)!;
    const target = path.join(folder, inputName(zone, kind as InputKind));
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new SubjectRefused(`${inputName(zone, kind as InputKind)} n'est pas un fichier réel : rien n'est écrit.`);
    tmp = path.join(folder, `${zone}.${kind}.${crypto.randomBytes(6).toString('hex')}.depot.tmp`);
    await receive(req, tmp);
    const header = readPngHeaderOfFile(tmp);
    if (!header) throw new ImageRefused('Ce fichier n\'est pas un PNG.');
    if (header.width !== render.width || header.height !== render.height) {
      throw new ImageRefused(`${kind === 'rendu' ? 'Rendu' : 'Passe Mist'} en ${header.width} × ${header.height} px : ${sizeText(render)} attendus pour une ${ZONE_KIND_LABELS[zk]} en ${ctx.trim.widthIn} × ${ctx.trim.heightIn}".`);
    }
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new ImageRefused(`${inputName(zone, kind as InputKind)} est ouvert dans un autre programme : le fermer, puis redéposer.`);
      throw e;
    }
    tmp = null;
    clearCandidates(config.dataRoot, bookId, subject, zone);
    return { deposited: { kind, size: { width: header.width, height: header.height } }, ...generateState(config, dir, subject, rt) };
  } finally {
    depositing = false;
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

/** Image corrigée d'un candidat, pour la vue « Générer ». Lecture seule ; le nom vient de la graine, jamais de ComfyUI. */
export function candidateBytes(query: URLSearchParams, config: Config): Buffer {
  const { dir, subject, zone, seed } = parse(candidateQuery, Object.fromEntries(query));
  const ctx = context(config, dir, subject);
  requireZone(ctx, zone);
  const bytes = cacheImage(config.dataRoot, ctx.book.bookId, subject, zone, correctedName(Number(seed)));
  if (!bytes) throw new SubjectRefused(`Aucun candidat de graine ${seed} pour la zone ${zone}.`);
  return bytes;
}

export { QueueRefused };
