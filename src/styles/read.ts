// src/styles/read.ts — lecture de la bibliothèque de styles (IC2) : `collection/styles/<styleId>/`, le rendu d'essai `collection/styles/_essai/`
// et le cache des aperçus `collection/.cache/styles/`. Lecture seule : le parcours s'en sert. Les écritures sont dans `files.ts`.
// Un style invalide est un fait, affiché avec son erreur : il n'est jamais corrigé ni réécrit par l'outil (question 1).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { collectionFolder } from '../data/collection';
import { isInside } from '../glbi/paths';
import { readPngHeader } from '../images/png';
import { schemaVersionSchema } from '../schema/common';
import { ESSAI_DIR, MAX_STYLES, REFERENCE_FILES, STYLE_FILE, STYLE_TEXT_MAX, styleIdSchema, styleSchema, BASE_STYLE_ID, type ReferenceFile, type Style } from './schema';

export class StyleRefused extends Error {}

export const STYLES_DIR = 'styles';
export const PREVIEW_CACHE = ['.cache', 'styles'] as const;
export const ESSAI_INPUTS = ['rendu', 'mist'] as const;
export type EssaiInput = (typeof ESSAI_INPUTS)[number];
export const ESSAI_FILE = 'essai.json';
/** Rendu d'essai fixe (question 8) : page pleine en 6 × 9", taille de génération du §13.2. */
export const ESSAI_SIZE = { width: 832, height: 1216 } as const;

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
export const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
export type ImageKind = 'png' | 'jpg';
/** PNG ou JPEG, par la signature : le nom de fichier ne prouve rien. */
export function imageKind(bytes: Buffer): ImageKind | null {
  if (readPngHeader(bytes)) return 'png';
  if (bytes.length > 3 && bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return 'jpg';
  return null;
}
export const referenceFileFor = (kind: ImageKind): ReferenceFile => (kind === 'png' ? 'reference.png' : 'reference.jpg');

/** Dossier réel sous `dataRoot`, ou `null`. Un lien ou un dossier qui sort de `dataRoot` est refusé : rien n'est lu ni écrit. */
export function realDir(dir: string, label: string, root: string): string | null {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StyleRefused(`${label} n'est pas un dossier réel : rien n'est lu ni écrit.`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new StyleRefused(`${label} sort de dataRoot : rien n'est lu ni écrit.`);
  return dir;
}

/** Fichier réel ou absent ; un lien est refusé. */
export function realFile(file: string, label: string): boolean {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw new StyleRefused(`${label} n'est pas un fichier réel : rien n'est lu ni écrit.`);
  return true;
}

/** `collection/styles/`, `null` tant qu'aucun style n'existe. */
export function stylesFolder(dataRoot: string): string | null {
  const collection = collectionFolder(dataRoot);
  if (!collection) throw new StyleRefused('collection/ absent : le créer d\'abord dans la page.');
  return realDir(path.join(collection, STYLES_DIR), 'collection/styles/', fs.realpathSync.native(dataRoot));
}

export interface ReferenceState {
  file: ReferenceFile;
  path: string;
  sha256: string;
  kind: ImageKind;
}

export type StyleState =
  | { id: string; state: 'ok'; style: Style; sha256: string; reference: ReferenceState | null; faults: string[] }
  | { id: string; state: 'refuse'; message: string };

/** Lit un style. `faults` : ce qui empêche de générer, sans rendre le fichier invalide (référence absente ou d'un autre format). */
export function readStyle(dataRoot: string, id: string): StyleState {
  // Un style en lien, ou dont un fichier est un lien, est refusé seul : le reste de la bibliothèque reste lisible.
  try {
    return readStyleUnsafe(dataRoot, id);
  } catch (e) {
    if (e instanceof StyleRefused) return { id, state: 'refuse', message: e.message };
    throw e;
  }
}

function readStyleUnsafe(dataRoot: string, id: string): StyleState {
  if (!styleIdSchema.safeParse(id).success) return { id, state: 'refuse', message: `collection/styles/${id}/ : nom de dossier refusé (minuscules, chiffres et tirets).` };
  const styles = stylesFolder(dataRoot);
  const label = `collection/styles/${id}/`;
  const dir = styles && realDir(path.join(styles, id), label, fs.realpathSync.native(dataRoot));
  if (!dir) return { id, state: 'refuse', message: `Style inconnu : ${id}.` };
  const file = path.join(dir, STYLE_FILE);
  if (!realFile(file, `${label}${STYLE_FILE}`)) return { id, state: 'refuse', message: `${label}${STYLE_FILE} absent.` };
  const bytes = fs.readFileSync(file);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { id, state: 'refuse', message: `${label}${STYLE_FILE} n'est pas un JSON valide : ${(e as Error).message}. Le fichier est conservé tel quel.` };
  }
  const parsed = styleSchema.safeParse(value);
  if (!parsed.success) return { id, state: 'refuse', message: `${label}${STYLE_FILE} invalide : ${issues(parsed.error)}. Le fichier est conservé tel quel.` };
  const style = parsed.data;
  const faults: string[] = [];
  let reference: ReferenceState | null = null;
  if (style.reference.type !== 'aucune') {
    const name = style.reference.file;
    if (!name) faults.push(`${style.name} : référence à déposer.`);
    else {
      const refPath = path.join(dir, name);
      if (!realFile(refPath, `${label}${name}`)) faults.push(`${style.name} : ${label}${name} absent, la référence est à redéposer.`);
      else {
        const refBytes = fs.readFileSync(refPath);
        const kind = imageKind(refBytes);
        if (!kind || referenceFileFor(kind) !== name) faults.push(`${style.name} : ${label}${name} n'est pas une image ${name.endsWith('.png') ? 'PNG' : 'JPEG'}, la redéposer.`);
        else reference = { file: name, path: refPath, sha256: sha256(refBytes), kind };
      }
    }
  }
  return { id, state: 'ok', style, sha256: sha256(bytes), reference, faults };
}

/** Tous les styles, le style de base d'abord, puis par identifiant. Un dossier au nom refusé est un style refusé, pas une panne. */
export function readStyles(dataRoot: string): StyleState[] {
  const dir = stylesFolder(dataRoot);
  if (!dir) return [];
  const names = fs.readdirSync(dir).filter((n) => n !== ESSAI_DIR && !n.startsWith('.')).sort((a, b) => (a === BASE_STYLE_ID ? -1 : b === BASE_STYLE_ID ? 1 : a.localeCompare(b)));
  if (names.length > MAX_STYLES) throw new StyleRefused(`collection/styles/ porte ${names.length} dossiers : ${MAX_STYLES} au plus.`);
  return names.map((n) => readStyle(dataRoot, n));
}

export const okStyle = (s: StyleState | undefined): (StyleState & { state: 'ok' }) | null => (s?.state === 'ok' ? s : null);

export const essaiSchema = z.strictObject({ schemaVersion: schemaVersionSchema, prompt: z.string().max(STYLE_TEXT_MAX) });

export interface EssaiState {
  inputs: Record<EssaiInput, { state: 'ok'; path: string; sha256: string } | { state: 'absent' } | { state: 'refuse'; message: string }>;
  /** `null` : pas encore réglé, le prompt du workflow sert. */
  prompt: string | null;
  promptError: string | null;
}

export function essaiFolder(dataRoot: string): string | null {
  const styles = stylesFolder(dataRoot);
  return styles && realDir(path.join(styles, ESSAI_DIR), `collection/styles/${ESSAI_DIR}/`, fs.realpathSync.native(dataRoot));
}

export function readEssai(dataRoot: string): EssaiState {
  const dir = essaiFolder(dataRoot);
  const inputs = Object.fromEntries(ESSAI_INPUTS.map((k) => {
    if (!dir) return [k, { state: 'absent' }];
    const file = path.join(dir, `${k}.png`);
    const label = `collection/styles/${ESSAI_DIR}/${k}.png`;
    if (!realFile(file, label)) return [k, { state: 'absent' }];
    const bytes = fs.readFileSync(file);
    const header = readPngHeader(bytes);
    if (!header) return [k, { state: 'refuse', message: `${label} n'est pas un PNG : le redéposer.` }];
    if (header.width !== ESSAI_SIZE.width || header.height !== ESSAI_SIZE.height) return [k, { state: 'refuse', message: `${label} en ${header.width} × ${header.height} px : ${ESSAI_SIZE.width} × ${ESSAI_SIZE.height} attendus.` }];
    return [k, { state: 'ok', path: file, sha256: sha256(bytes) }];
  })) as EssaiState['inputs'];
  let prompt: string | null = null;
  let promptError: string | null = null;
  const file = dir && path.join(dir, ESSAI_FILE);
  if (file && realFile(file, `collection/styles/${ESSAI_DIR}/${ESSAI_FILE}`)) {
    try {
      const parsed = essaiSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
      if (parsed.success) prompt = parsed.data.prompt;
      else promptError = `collection/styles/${ESSAI_DIR}/${ESSAI_FILE} invalide : ${issues(parsed.error)}.`;
    } catch (e) {
      promptError = `collection/styles/${ESSAI_DIR}/${ESSAI_FILE} n'est pas un JSON valide : ${(e as Error).message}.`;
    }
  }
  return { inputs, prompt, promptError };
}

/** `collection/.cache/styles/`, hors git par `*\/.cache/` (P-15). `null` s'il n'existe pas. */
export function previewFolder(dataRoot: string): string | null {
  const collection = collectionFolder(dataRoot);
  if (!collection) return null;
  const root = fs.realpathSync.native(dataRoot);
  let dir = collection;
  let label = 'collection/';
  for (const segment of PREVIEW_CACHE) {
    dir = path.join(dir, segment);
    label += `${segment}/`;
    if (!realDir(dir, label, root)) return null;
  }
  return dir;
}

export const previewName = (id: string, key: string) => `${id}.${key}.png`;
export const PREVIEW_KEY = /^[0-9a-f]{16}$/;

/** L'aperçu en cache, ou `null`. Le nom vient de l'identifiant et de la clé, jamais de la requête telle quelle. */
export function readPreview(dataRoot: string, id: string, key: string): Buffer | null {
  if (!styleIdSchema.safeParse(id).success || !PREVIEW_KEY.test(key)) throw new StyleRefused(`Aperçu refusé : ${id}.${key}.`);
  const dir = previewFolder(dataRoot);
  if (!dir) return null;
  const file = path.join(dir, previewName(id, key));
  return realFile(file, `collection/.cache/styles/${previewName(id, key)}`) ? fs.readFileSync(file) : null;
}
