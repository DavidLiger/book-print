// src/comfy/run.ts — enchaînement d'IL1 par l'outil (spec §11.1, §13.2) : génération sur trois graines, correction Lab locale de chaque image à la
// taille de génération, puis agrandissement de l'image choisie et rangement par le chemin du dépôt de MP4. Tout ce qu'une tâche lit (graphes,
// droits, entrées, candidat) est pris quand David la lance : une tâche en attente ne change pas si un fichier change entre-temps.
import fs from 'node:fs';
import { storeIllustration } from '../data/illustration-store';
import { cleanPng } from '../images/clean';
import type { Size } from '../images/crop';
import type { Generation } from '../schema/subject';
import { ComfyClient, ComfyError, executionError, type HistoryEntry, type ImageFile } from './client';
import { correctColors } from './colors';
import { cacheFolder, clearCandidates, correctedName, generatedName, CANDIDATES_FILE, candidatesSchema, writeCacheFile, type Candidates } from './files';
import { COLOR_DOSAGE } from './lab';
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

/** La référence de style reste dans le dossier d'entrée de ComfyUI (question 3) : son empreinte est lue par `/view`, sans accès au disque. */
async function referenceHash(client: ComfyClient, name: string): Promise<string> {
  const at = name.lastIndexOf('/');
  try {
    return sha256((await client.view({ filename: name.slice(at + 1), subfolder: at < 0 ? '' : name.slice(0, at), type: 'input' })).png);
  } catch (e) {
    throw new ComfyError(`Référence de style ${name} introuvable dans le dossier d'entrée de ComfyUI : ${(e as Error).message}`);
  }
}

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
  workflow: { entry: WorkflowEntry; graph: Graph };
  referenceName: string;
}

export async function runGeneration(job: GenerationJob, ctx: TaskContext, deps: RunDeps): Promise<string> {
  const client = deps.client(job.origin);
  const { dataRoot, bookId, subjectId, zone } = job;
  ctx.progress('contrôle de ComfyUI');
  const { version } = await client.systemStats();
  if (ctx.cancelled()) throw new TaskCancelled('annulée avant son envoi');
  ctx.progress('dépôt du rendu et de la Mist');
  const renduName = await client.upload(comfyInputName(bookId, subjectId, zone, 'rendu'), job.rendu);
  const mistName = await client.upload(comfyInputName(bookId, subjectId, zone, 'mist'), job.mist);
  const reference = { name: job.referenceName, sha256: await referenceHash(client, job.referenceName) };
  // Les anciens candidats restent jusqu'à la première image nouvelle : un agrandissement lancé entre-temps les a déjà emportés.
  let dir: string | null = null;
  const candidates: Candidates['candidates'] = [];
  const ours = new Set<string>();
  for (const [i, seed] of job.seeds.entries()) {
    const step = `graine ${i + 1} sur ${job.seeds.length}`;
    const start = deps.now().getTime();
    const fields: FieldChanges = { '3': { seed }, '6': { text: job.prompt }, '9': { filename_prefix: outputPrefix(subjectId, zone, `g${seed}`) }, '10': { image: renduName }, '11': { image: mistName } };
    const image = await execute(client, applyFields(job.workflow.graph, 'generation', fields), SPECS.generation.output, ctx, deps, step, ours);
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
    const corrected = await correctColors(image.png, job.rendu, COLOR_DOSAGE);
    const correctionSeconds = Math.round((deps.now().getTime() - correctionStart) / 100) / 10;
    writeCacheFile(dir, correctedName(seed), corrected);
    candidates.push({ seed, generated: sha256(image.png), corrected: sha256(corrected), fields, seconds: Math.round((deps.now().getTime() - start) / 100) / 10, correctionSeconds });
  }
  const file: Candidates = candidatesSchema.parse({
    schemaVersion: 1,
    date: deps.now().toISOString(),
    comfyuiVersion: version,
    prompt: job.prompt,
    dosage: COLOR_DOSAGE,
    workflow: { file: job.workflow.entry.file, date: job.workflow.entry.date, sha256: job.workflow.entry.sha256 },
    inputs: { rendu: sha256(job.rendu), mist: sha256(job.mist), reference },
    size: job.renderSize,
    candidates,
  });
  writeCacheFile(dir!, CANDIDATES_FILE, `${JSON.stringify(file, null, 2)}\n`);
  return `${candidates.length} images générées et corrigées, graines ${job.seeds.join(', ')}.`;
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
  workflows: { generation: WorkflowEntry; agrandissement: { entry: WorkflowEntry; graph: Graph } };
  /** Droits de l'image finale : ceux des deux workflows, plus les modèles 3D déjà rattachés à la zone. */
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
  const fields: FieldChanges = {
    '10': { image: source },
    '32': { seed },
    '34': { width: job.output.width, height: job.output.height, crop: 'center' },
    '35': { filename_prefix: outputPrefix(subjectId, zone, `final_g${seed}`) },
  };
  const start = deps.now().getTime();
  const image = await execute(client, applyFields(job.workflows.agrandissement.graph, 'agrandissement', fields), SPECS.agrandissement.output, ctx, deps, 'agrandissement', new Set());
  if (image.width !== job.output.width || image.height !== job.output.height) throw new ComfyError(`Image agrandie en ${image.width} × ${image.height} px, ${job.output.width} × ${job.output.height} attendus.`);
  ctx.progress('nettoyage et rangement');
  const cleaned = await cleanPng(image.png);
  const generation: Generation = {
    date: deps.now().toISOString(),
    comfyuiVersion: version,
    seed,
    prompt: job.candidates.prompt,
    dosage: job.candidates.dosage,
    workflows: {
      generation: { file: job.workflows.generation.file, date: job.workflows.generation.date, sha256: job.workflows.generation.sha256 },
      agrandissement: { file: job.workflows.agrandissement.entry.file, date: job.workflows.agrandissement.entry.date, sha256: job.workflows.agrandissement.entry.sha256 },
    },
    fields: { generation: candidate.fields, agrandissement: fields },
    inputs: { rendu: job.candidates.inputs.rendu, mist: job.candidates.inputs.mist, reference: job.candidates.inputs.reference, generated: candidate.generated, corrected: candidate.corrected },
  };
  storeIllustration(dataRoot, bookId, subjectId, zone, cleaned, { generation, rights: job.rights });
  return `Image finale rangée : ${cleaned.width} × ${cleaned.height} px, graine ${seed}, ${mmss(deps.now().getTime() - start)} de calcul.`;
}

/** Les entrées lues au lancement d'une génération : jamais un chemin venu de ComfyUI. */
export const readInput = (file: string) => fs.readFileSync(file);
