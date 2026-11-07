// src/comfy/workflow.ts — les deux graphes d'IL1 au format API de ComfyUI (spec §13.5), fonctions pures. Chaque nœud cité est contrôlé avec son
// `class_type`, chaque champ avec son type. L'outil ne change que les champs marqués `set`, sur une copie : tout le reste du graphe part tel
// que David l'a déposé. Les identifiants de nœuds ne changent que si le graphe est modifié dans ComfyUI : l'outil ne régénère rien.
import crypto from 'node:crypto';

export const WORKFLOW_KINDS = ['generation', 'agrandissement'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];
export const WORKFLOW_LABELS: Record<WorkflowKind, string> = { generation: 'génération', agrandissement: 'agrandissement' };

export type FieldValue = string | number;
interface FieldSpec {
  type: 'number' | 'string';
  /** Champ écrit par l'outil. Les autres sont seulement contrôlés : ils restent ceux du fichier (question 3 d'IC1). */
  set: boolean;
}
interface NodeSpec {
  classType: string;
  role: string;
  fields: Record<string, FieldSpec>;
}
export interface WorkflowSpec {
  nodes: Record<string, NodeSpec>;
  /** Nœud `SaveImage` dont la sortie est reprise : jamais « la dernière image » de l'historique. */
  output: string;
  /** Droits proposés au premier dépôt, s'ils sont au registre (question 8). David coche ensuite. */
  defaultRights: string[];
}

const num = (set = false): FieldSpec => ({ type: 'number', set });
const str = (set = false): FieldSpec => ({ type: 'string', set });

export const SPECS: Record<WorkflowKind, WorkflowSpec> = {
  generation: {
    nodes: {
      '3': { classType: 'KSampler', role: 'échantillonneur', fields: { seed: num(true), denoise: num() } },
      '6': { classType: 'CLIPTextEncode', role: 'prompt positif', fields: { text: str(true) } },
      '7': { classType: 'CLIPTextEncode', role: 'prompt négatif', fields: { text: str() } },
      '9': { classType: 'SaveImage', role: 'sortie', fields: { filename_prefix: str(true) } },
      '10': { classType: 'LoadImage', role: 'rendu', fields: { image: str(true) } },
      '11': { classType: 'LoadImage', role: 'passe Mist', fields: { image: str(true) } },
      '22': { classType: 'LoadImage', role: 'référence de style', fields: { image: str() } },
      '24': { classType: 'IPAdapterAdvanced', role: 'IP-Adapter', fields: { weight: num() } },
      '26': { classType: 'ControlNetApplyAdvanced', role: 'ControlNet tile', fields: { strength: num() } },
    },
    output: '9',
    defaultRights: ['sdxl-base-1-0', 'controlnet-union-promax', 'ip-adapter-plus-sdxl-vit-h', 'clip-vit-h-14', 'niedot294a'],
  },
  agrandissement: {
    nodes: {
      '10': { classType: 'LoadImage', role: 'image choisie', fields: { image: str(true) } },
      '32': { classType: 'UltimateSDUpscale', role: 'Ultimate SD Upscale', fields: { seed: num(true), denoise: num() } },
      '34': { classType: 'ImageScale', role: 'taille finale', fields: { width: num(true), height: num(true), crop: str(true) } },
      '35': { classType: 'SaveImage', role: 'sortie', fields: { filename_prefix: str(true) } },
    },
    output: '35',
    defaultRights: ['sdxl-base-1-0', 'realesrgan-x4plus'],
  },
};

/** Types de droits qu'un workflow peut porter (question 8) : ni modèle 3D, rattaché par zone, ni extension, qui ne porte que sur du code. */
export const WORKFLOW_RIGHTS_KINDS = ['modele-ia', 'controlnet', 'upscaler', 'image-reference'] as const;

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> } & Record<string, unknown>>;

export class WorkflowRefused extends Error {}

export const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Contrôle le graphe et rend les refus, nommés. Liste vide : le graphe convient. */
export function graphFaults(value: unknown, kind: WorkflowKind): string[] {
  if (!isObject(value)) return ['le fichier doit être un objet JSON'];
  if (Array.isArray(value.nodes) || Array.isArray(value.links)) return ['ce fichier est au format de l\'interface, pas au format API : prendre le JSON au format API (métadonnée « prompt » du PNG, ou export API)'];
  const faults: string[] = [];
  for (const [id, node] of Object.entries(value)) {
    if (!isObject(node) || typeof node.class_type !== 'string' || !isObject(node.inputs)) faults.push(`nœud ${id} : class_type et inputs attendus`);
  }
  for (const [id, spec] of Object.entries(SPECS[kind].nodes)) {
    const node = value[id];
    const name = `nœud ${id} (${spec.classType}, ${spec.role})`;
    if (!isObject(node)) {
      faults.push(`${name} absent`);
      continue;
    }
    if (node.class_type !== spec.classType) {
      faults.push(`${name} : ${spec.classType} attendu, ${String(node.class_type)} trouvé`);
      continue;
    }
    if (!isObject(node.inputs)) continue;
    for (const [field, f] of Object.entries(spec.fields)) {
      const v = node.inputs[field];
      if (v === undefined) faults.push(`${name}, champ ${field} absent`);
      else if (f.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== 'string') faults.push(`${name}, champ ${field} : ${f.type === 'number' ? 'nombre' : 'texte'} attendu, pas un lien ni une autre valeur`);
    }
  }
  return faults;
}

export function parseGraph(content: string, kind: WorkflowKind): Graph {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^﻿/, ''));
  } catch (e) {
    throw new WorkflowRefused(`Workflow de ${WORKFLOW_LABELS[kind]} : JSON invalide (${(e as Error).message}).`);
  }
  const faults = graphFaults(value, kind);
  if (faults.length > 0) throw new WorkflowRefused(`Workflow de ${WORKFLOW_LABELS[kind]} refusé : ${faults.join(' ; ')}.`);
  return value as Graph;
}

export type FieldChanges = Record<string, Record<string, FieldValue>>;

/** Copie du graphe, avec les seuls champs déclarés `set`. Un champ non déclaré est refusé : rien d'autre ne peut changer. */
export function applyFields(graph: Graph, kind: WorkflowKind, changes: FieldChanges): Graph {
  const copy = structuredClone(graph);
  for (const [id, fields] of Object.entries(changes)) {
    const spec = SPECS[kind].nodes[id];
    for (const [field, v] of Object.entries(fields)) {
      const f = spec?.fields[field];
      if (!f?.set) throw new WorkflowRefused(`Champ non déclaré : nœud ${id}, ${field}.`);
      if (f.type === 'number' ? typeof v !== 'number' : typeof v !== 'string') throw new WorkflowRefused(`Nœud ${id}, ${field} : type refusé.`);
      copy[id]!.inputs[field] = v;
    }
  }
  return copy;
}

/** Valeur d'un champ contrôlé du graphe : le prompt par défaut, le nom de la référence. */
export const fieldOf = (graph: Graph, id: string, field: string): FieldValue => graph[id]!.inputs[field] as FieldValue;
