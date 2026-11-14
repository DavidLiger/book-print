// src/comfy/run.ts — enchaînement d'IL1 par l'outil (spec §11.1, §13.2) : génération sur trois graines, correction Lab locale de chaque image à la
// taille de génération, puis agrandissement de l'image choisie et rangement par le chemin du dépôt de MP4. Tout ce qu'une tâche lit (graphes,
// droits, entrées, candidat) est pris quand David la lance : une tâche en attente ne change pas si un fichier change entre-temps.
import fs from 'node:fs';
import { storeIllustration } from '../data/illustration-store';
import { cleanPng } from '../images/clean';
import { contourOf, ContourRefused, type Contour } from '../images/contour';
import type { Size } from '../images/crop';
import type { Generation } from '../schema/subject';
import { ComfyClient, ComfyError, executionError, type HistoryEntry, type ImageFile } from './client';
import { correctColors } from './colors';
import { alphaForOutput, fingerprint, flattenOnGray } from './detoure';
import { keepImageChunks } from '../images/png';
import { writePreview } from '../styles/files';
import { generationGraph, upscaleFields } from '../styles/graph';
import type { ImageKind } from '../styles/read';
import type { Style } from '../styles/schema';
import { cacheFolder, clearCandidates, correctedName, generatedName, CANDIDATES_FILE, candidatesSchema, writeCacheFile, type Candidates } from './files';
import { TaskCancelled, type TaskContext } from './queue';
import type { WorkflowEntry } from './workflow-file';
import { applyFields, sha256, SPECS, type FieldChanges, type Graph } from './workflow';

export interface RunDeps {
  client: (origin: string) => ComfyClient;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Attente entre deux lectures de `/history` (2 s) et de `/queue` quand ComfyUI est occupé (5 s). */
  historyPollMs: number;
  busyPollMs: number;
  /** Au-delà, la tâche échoue : 30 min, comme `il1-fin.py`. */
  maxWaitMs: number;
}
export const defaultRunDeps = (): RunDeps => ({
  client: (origin) => new ComfyClient(origin),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  historyPollMs: 2000,
  busyPollMs: 5000,
  maxWaitMs: 30 * 60 * 1000,
});

/** Identifiant de client envoyé à ComfyUI avec chaque graphe. */
export const CLIENT_ID = 'book-print';

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

/**
 * Attend que la file de ComfyUI soit vide : rien ne part en parallèle d'un travail lancé à la main (P-14). Une tâche que l'outil vient de finir peut
 * rester un instant dans `queue_running` après son historique : `ours` l'écarte.
 */
async function waitIdle(client: ComfyClient, ctx: TaskContext, deps: RunDeps, ours: Set<string>): Promise<void> {
  const start = deps.now().getTime();
  for (;;) {
    if (ctx.cancelled()) throw new TaskCancelled('annulée avant son envoi');
    const q = await client.queue();
    const others = q.running + q.pending - q.ids.filter((id) => ours.has(id)).length;
    if (others <= 0) return;
    if (deps.now().getTime() - start > deps.maxWaitMs) throw new ComfyError(`ComfyUI reste occupé depuis ${mmss(deps.maxWaitMs)} : tâche abandonnée, la relancer.`);
    ctx.progress(`ComfyUI occupé (${others} tâche${others > 1 ? 's' : ''} hors de l'outil) : attente`);
    await deps.sleep(deps.busyPollMs);
  }
}

/** Envoie un graphe et attend son résultat. Jusqu'à trois lectures de `/history` manquées de suite sont tolérées. */
async function execute(client: ComfyClient, graph: Graph, outputNode: string, ctx: TaskContext, deps: RunDeps, step: string, ours: Set<string>): Promise<ImageFile> {
  await waitIdle(client, ctx, deps, ours);
  ctx.progress(`${step} : envoi`);
  const id = await client.prompt(graph, CLIENT_ID);
  ours.add(id);
  ctx.sent();
  const start = deps.now().getTime();
  let misses = 0;
  let entry: HistoryEntry | null = null;
  for (;;) {
    await deps.sleep(deps.historyPollMs);
    ctx.progress(`${step} : calcul, ${mmss(deps.now().getTime() - start)}`);
    try {
      entry = await client.history(id);
      misses = 0;
    } catch (e) {
      if (!(e instanceof ComfyError) || ++misses > 3) throw e;
    }
    if (entry) break;
    if (deps.now().getTime() - start > deps.maxWaitMs) throw new ComfyError(`Plus de ${mmss(deps.maxWaitMs)} sans résultat de ComfyUI : tâche abandonnée.`);
  }
  const failed = executionError(entry);
  if (failed) throw new ComfyError(failed);
  const image = entry.outputs[outputNode]?.images?.[0];
  if (!image) throw new ComfyError(`ComfyUI n'a rendu aucune image au nœud ${outputNode}.`);
  ctx.progress(`${step} : récupération`);
  return client.view(image);
}

/** Nom à plat dans le dossier d'entrée de ComfyUI, propre à l'outil : `bookprint_<livre>_<sujet>_<zone>_<suffixe>.png`. */
export const comfyInputName = (bookId: string, subjectId: string, zone: string, suffix: string) => `bookprint_${bookId}_${subjectId}_${zone}_${suffix}.png`;
const outputPrefix = (subjectId: string, zone: string, suffix: string) => `book-print/${subjectId}_${zone}_${suffix}`;

/** Le style emporté par une tâche (IC2) : lu au lancement, il ne change pas si David le modifie pendant que la tâche attend. */
export interface StyleRun {
  id: string;
  /** Empreinte de `style.json`, tracée avec l'image. */
  sha256: string;
  style: Style;
  /** Octets de la référence, tels que rangés dans le style ; `null` sans référence. */
  reference: { bytes: Buffer; kind: ImageKind } | null;
}

/** Copie en niveaux de gris d'une référence (question 5) : l'original reste dans le style. */
export async function grayscaleCopy(bytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const out = await sharp(bytes, { limitInputPixels: 64_000_000 }).grayscale().toColourspace('srgb').png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  return keepImageChunks(out);
}

/** Nom de la référence dans le dossier d'entrée de ComfyUI : `bookprint_style_<styleId>.<ext>`, ou `_gris.png` pour la copie en gris. */
export const referenceInputName = (styleId: string, kind: ImageKind, gray: boolean) => (gray ? `bookprint_style_${styleId}_gris.png` : `bookprint_style_${styleId}.${kind}`);

/** Dépose la référence du style au moment de générer, avec l'empreinte des octets envoyés. `null` : style sans référence. */
async function uploadReference(client: ComfyClient, s: StyleRun): Promise<{ name: string; sha256: string } | null> {
  if (!s.reference || s.style.reference.type === 'aucune') return null;
  const gray = s.style.reference.grayscale;
  const bytes = gray ? await grayscaleCopy(s.reference.bytes) : s.reference.bytes;
  const kind = gray ? 'png' : s.reference.kind;
  const name = await client.upload(referenceInputName(s.id, kind, gray), bytes, kind === 'png' ? 'image/png' : 'image/jpeg');
  return { name, sha256: sha256(bytes) };
}

/** Correction de couleurs au dosage du style. À 0, sans correction : l'image générée, sans ses métadonnées. */
async function correct(generated: Buffer, rendu: Buffer, dosage: number): Promise<Buffer> {
  return dosage === 0 ? keepImageChunks(generated) : correctColors(generated, rendu, dosage);
}

/** Droit de la référence d'un style : il passe à l'image finale (question 6). */
export const referenceRights = (style: Style): string | null => (style.reference.type === 'aucune' ? null : style.reference.rights);

export interface GenerationJob {
  dataRoot: string;
  bookId: string;
  subjectId: string;
  zone: string;
  origin: string;
  prompt: string;
  seeds: number[];
  rendu: Buffer;
  mist: Buffer;
  renderSize: Size;
  /** Zone détourée (ED5) : `rendu` est un RVBA, aplati sur ce gris avant l'envoi. */
  detoure?: { fond: number };
  workflow: { entry: WorkflowEntry; graph: Graph };
  style: StyleRun;
}

export async function runGeneration(job: GenerationJob, ctx: TaskContext, deps: RunDeps): Promise<string> {
  const client = deps.client(job.origin);
  const { dataRoot, bookId, subjectId, zone } = job;
  ctx.progress('contrôle de ComfyUI');
  const { version } = await client.systemStats();
  if (ctx.cancelled()) throw new TaskCancelled('annulée avant son envoi');
  ctx.progress('dépôt du rendu et de la Mist');
  const sentRendu = job.detoure ? await flattenOnGray(job.rendu, job.detoure.fond) : job.rendu;
  const renduName = await client.upload(comfyInputName(bookId, subjectId, zone, 'rendu'), sentRendu);
  const mistName = await client.upload(comfyInputName(bookId, subjectId, zone, 'mist'), job.mist);
  const reference = await uploadReference(client, job.style);
  const { style } = job.style;
  // Les anciens candidats restent jusqu'à la première image nouvelle : un agrandissement lancé entre-temps les a déjà emportés.
  let dir: string | null = null;
  const candidates: Candidates['candidates'] = [];
  const ours = new Set<string>();
  for (const [i, seed] of job.seeds.entries()) {
    const step = `graine ${i + 1} sur ${job.seeds.length}`;
    const start = deps.now().getTime();
    const { graph, fields } = generationGraph(job.workflow.graph, style, { seed, zonePrompt: job.prompt, renduName, mistName, referenceName: reference?.name ?? null, prefix: outputPrefix(subjectId, zone, `g${seed}`) });
    const image = await execute(client, graph, SPECS.generation.output, ctx, deps, step, ours);
    if (image.width !== job.renderSize.width || image.height !== job.renderSize.height) {
      throw new ComfyError(`Image générée en ${image.width} × ${image.height} px, ${job.renderSize.width} × ${job.renderSize.height} attendus : le workflow ne garde pas la taille du rendu.`);
    }
    if (!dir) {
      clearCandidates(dataRoot, bookId, subjectId, zone);
      dir = cacheFolder(dataRoot, bookId, subjectId, zone, true)!;
    }
    writeCacheFile(dir, generatedName(seed), image.png);
    ctx.progress(`${step} : correction des couleurs`);
    const correctionStart = deps.now().getTime();
    const corrected = await correct(image.png, sentRendu, style.colorDosage);
    const correctionSeconds = Math.round((deps.now().getTime() - correctionStart) / 100) / 10;
    writeCacheFile(dir, correctedName(seed), corrected);
    candidates.push({ seed, generated: sha256(image.png), corrected: sha256(corrected), fields, seconds: Math.round((deps.now().getTime() - start) / 100) / 10, correctionSeconds });
  }
  const file: Candidates = candidatesSchema.parse({
    schemaVersion: 1,
    date: deps.now().toISOString(),
    comfyuiVersion: version,
    prompt: job.prompt,
    dosage: style.colorDosage,
    workflow: { file: job.workflow.entry.file, date: job.workflow.entry.date, sha256: job.workflow.entry.sha256 },
    style: { id: job.style.id, sha256: job.style.sha256, upscale: style.upscale, rights: referenceRights(style) },
    ...(job.detoure ? { detoure: { fond: job.detoure.fond, rendu: sha256(job.rendu), aplati: sha256(sentRendu) } } : {}),
    inputs: { rendu: sha256(job.rendu), mist: sha256(job.mist), reference },
    size: job.renderSize,
    candidates,
  });
  writeCacheFile(dir!, CANDIDATES_FILE, `${JSON.stringify(file, null, 2)}\n`);
  const n = candidates.length;
  return `${n} image${n > 1 ? 's générées et corrigées' : ' générée et corrigée'}, style ${style.name}, graine${n > 1 ? 's' : ''} ${job.seeds.join(', ')}.`;
}

export interface UpscaleJob {
  dataRoot: string;
  bookId: string;
  subjectId: string;
  zone: string;
  origin: string;
  seed: number;
  corrected: Buffer;
  candidates: Candidates;
  output: Size;
  /** Zone détourée (ED5) : le rendu RVBA et sa taille, dont l'alpha donne le contour de l'image finale. */
  detoure?: { rendu: Buffer; renderSize: Size };
  workflows: { generation: WorkflowEntry; agrandissement: { entry: WorkflowEntry; graph: Graph } };
  /** Droits de l'image finale : ceux des deux workflows, la référence du style et les modèles 3D déjà rattachés à la zone. */
  rights: string[];
}

export async function runUpscale(job: UpscaleJob, ctx: TaskContext, deps: RunDeps): Promise<string> {
  const client = deps.client(job.origin);
  const { dataRoot, bookId, subjectId, zone, seed } = job;
  const candidate = job.candidates.candidates.find((c) => c.seed === seed);
  if (!candidate) throw new ComfyError(`Graine ${seed} absente des candidats.`);
  ctx.progress('contrôle de ComfyUI');
  const { version } = await client.systemStats();
  if (ctx.cancelled()) throw new TaskCancelled('annulée avant son envoi');
  ctx.progress('dépôt de l\'image choisie');
  const source = await client.upload(comfyInputName(bookId, subjectId, zone, `c${seed}`), job.corrected);
  const fields: FieldChanges = upscaleFields(job.candidates.style.upscale, { seed, sourceName: source, width: job.output.width, height: job.output.height, prefix: outputPrefix(subjectId, zone, `final_g${seed}`) });
  const start = deps.now().getTime();
  const image = await execute(client, applyFields(job.workflows.agrandissement.graph, 'agrandissement', fields), SPECS.agrandissement.output, ctx, deps, 'agrandissement', new Set());
  if (image.width !== job.output.width || image.height !== job.output.height) throw new ComfyError(`Image agrandie en ${image.width} × ${image.height} px, ${job.output.width} × ${job.output.height} attendus.`);
  ctx.progress('nettoyage et rangement');
  const cleaned = await cleanPng(image.png);
  let contour: Contour | undefined;
  let detoure: Generation['detoure'];
  if (job.detoure) {
    const cand = job.candidates.detoure;
    if (!cand) throw new ComfyError('Candidats sans trace de détouré : relancer la génération.');
    ctx.progress('alpha et contour');
    const alpha = await alphaForOutput(job.detoure.rendu, job.detoure.renderSize, job.output);
    try {
      contour = contourOf(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.length), job.output.width, job.output.height);
    } catch (e) {
      if (e instanceof ContourRefused) throw new ComfyError(`Rendu RVBA inutilisable : ${e.message}`);
      throw e;
    }
    detoure = { fond: cand.fond, rendu: cand.rendu, aplati: cand.aplati, alpha: fingerprint(alpha) };
  }
  const generation: Generation = {
    date: deps.now().toISOString(),
    comfyuiVersion: version,
    seed,
    prompt: job.candidates.prompt,
    dosage: job.candidates.dosage,
    style: { id: job.candidates.style.id, sha256: job.candidates.style.sha256 },
    workflows: {
      generation: { file: job.workflows.generation.file, date: job.workflows.generation.date, sha256: job.workflows.generation.sha256 },
      agrandissement: { file: job.workflows.agrandissement.entry.file, date: job.workflows.agrandissement.entry.date, sha256: job.workflows.agrandissement.entry.sha256 },
    },
    fields: { generation: candidate.fields, agrandissement: fields },
    inputs: { rendu: job.candidates.inputs.rendu, mist: job.candidates.inputs.mist, reference: job.candidates.inputs.reference, generated: candidate.generated, corrected: candidate.corrected },
    ...(detoure ? { detoure } : {}),
  };
  storeIllustration(dataRoot, bookId, subjectId, zone, cleaned, { generation, rights: job.rights, ...(contour ? { contour } : {}) });
  return `Image finale rangée : ${cleaned.width} × ${cleaned.height} px, graine ${seed}, ${mmss(deps.now().getTime() - start)} de calcul.`;
}

/** Graine fixe des aperçus de style (question 8) : celle de l'image du livre 1 tracée en IC1. */
export const PREVIEW_SEED = 2397429127;

export interface PreviewJob {
  dataRoot: string;
  origin: string;
  /** Clé de l'aperçu : empreinte du style, de sa référence, des entrées d'essai, du prompt, du workflow et de la graine. */
  key: string;
  prompt: string;
  rendu: Buffer;
  mist: Buffer;
  workflow: { entry: WorkflowEntry; graph: Graph };
  style: StyleRun;
}

/** Aperçu d'un style : une génération à graine fixe sur le rendu d'essai, corrigée, sans agrandissement, rangée dans `collection/.cache/styles/`. */
export async function runPreview(job: PreviewJob, ctx: TaskContext, deps: RunDeps): Promise<string> {
  const client = deps.client(job.origin);
  ctx.progress('contrôle de ComfyUI');
  await client.systemStats();
  if (ctx.cancelled()) throw new TaskCancelled('annulée avant son envoi');
  ctx.progress('dépôt du rendu d\'essai');
  const renduName = await client.upload('bookprint_style_essai_rendu.png', job.rendu);
  const mistName = await client.upload('bookprint_style_essai_mist.png', job.mist);
  const reference = await uploadReference(client, job.style);
  const { style } = job.style;
  const { graph } = generationGraph(job.workflow.graph, style, { seed: PREVIEW_SEED, zonePrompt: job.prompt, renduName, mistName, referenceName: reference?.name ?? null, prefix: `book-print/styles/${job.style.id}_${job.key}` });
  const start = deps.now().getTime();
  const image = await execute(client, graph, SPECS.generation.output, ctx, deps, `aperçu du style ${style.name}`, new Set());
  ctx.progress('correction des couleurs');
  const corrected = await correct(image.png, job.rendu, style.colorDosage);
  writePreview(job.dataRoot, job.style.id, job.key, corrected);
  return `Aperçu du style ${style.name} rangé, ${mmss(deps.now().getTime() - start)} de calcul.`;
}

/** Les entrées lues au lancement d'une génération : jamais un chemin venu de ComfyUI. */
export const readInput = (file: string) => fs.readFileSync(file);
