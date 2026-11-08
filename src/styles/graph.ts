// src/styles/graph.ts — d'un style aux champs du graphe (IC2, questions 2, 3, 4 et 12), fonctions pures. Seuls les champs déclarés `set` de
// `SPECS` changent, plus le lien `model` du nœud 3 pour un style sans référence (`REFERENCE_BYPASS`). Le style de base reprend les valeurs du
// graphe : envoyé avec lui, le graphe est celui d'IC1, au nom de la référence près.
import { applyFields, fieldOf, withoutReference, type FieldChanges, type Graph } from '../comfy/workflow';
import { styleSchema, type ReferenceFile, type Style } from './schema';

/** Positif = prompt de la zone, puis le prompt de style s'il n'est pas vide, séparés par `, ` (question 3). */
export function composePrompt(zonePrompt: string, style: Style): string {
  const extra = style.prompt.trim();
  return extra === '' ? zonePrompt : `${zonePrompt}, ${extra}`;
}

export interface GenerationRun {
  seed: number;
  zonePrompt: string;
  renduName: string;
  mistName: string;
  /** Nom de la référence dans le dossier d'entrée de ComfyUI ; `null` pour un style sans référence. */
  referenceName: string | null;
  prefix: string;
}

/** Les champs écrits dans le graphe de génération, tels qu'ils sont tracés. Sans référence, ni le nœud 22 ni le nœud 24 ne sont écrits : ils ne tournent pas. */
export function generationFields(style: Style, run: GenerationRun): FieldChanges {
  const { depth, canny, tile } = style.controlnet;
  return {
    '3': { seed: run.seed, denoise: style.denoise },
    '6': { text: composePrompt(run.zonePrompt, style) },
    '7': { text: style.negative },
    '9': { filename_prefix: run.prefix },
    '10': { image: run.renduName },
    '11': { image: run.mistName },
    '16': { strength: depth.strength },
    '17': { strength: canny.strength },
    '26': { strength: tile.strength, start_percent: tile.start, end_percent: tile.end },
    ...(run.referenceName !== null ? { '22': { image: run.referenceName }, '24': { weight: style.ipAdapterWeight } } : {}),
  };
}

export function generationGraph(base: Graph, style: Style, run: GenerationRun): { graph: Graph; fields: FieldChanges } {
  const fields = generationFields(style, run);
  const graph = applyFields(base, 'generation', fields);
  return { graph: run.referenceName === null ? withoutReference(graph) : graph, fields };
}

export interface UpscaleRun {
  seed: number;
  sourceName: string;
  width: number;
  height: number;
  prefix: string;
}

export function upscaleFields(prompts: Style['upscale'], run: UpscaleRun): FieldChanges {
  return {
    '6': { text: prompts.prompt },
    '7': { text: prompts.negative },
    '10': { image: run.sourceName },
    '32': { seed: run.seed },
    '34': { width: run.width, height: run.height, crop: 'center' },
    '35': { filename_prefix: run.prefix },
  };
}

/**
 * Style de base (question 2) : les valeurs du graphe de génération et du graphe d'agrandissement, un dosage de 100 %, un prompt de style vide.
 * La référence est celle du nœud 22, rangée dans le style et rattachée à `rights`.
 */
export function baseStyle(generation: Graph, upscale: Graph, rights: string, file: ReferenceFile | null): Style {
  const n = (id: string, field: string) => Number(fieldOf(generation, id, field));
  return styleSchema.parse({
    schemaVersion: 1,
    name: 'Style de base',
    description: 'Style du livre 1, repris des workflows d\'IL1.',
    prompt: '',
    negative: String(fieldOf(generation, '7', 'text')),
    denoise: n('3', 'denoise'),
    ipAdapterWeight: n('24', 'weight'),
    controlnet: {
      depth: { strength: n('16', 'strength') },
      canny: { strength: n('17', 'strength') },
      tile: { strength: n('26', 'strength'), start: n('26', 'start_percent'), end: n('26', 'end_percent') },
    },
    colorDosage: 1,
    reference: { type: 'externe', rights, file, grayscale: false },
    upscale: { prompt: String(fieldOf(upscale, '6', 'text')), negative: String(fieldOf(upscale, '7', 'text')) },
  });
}
