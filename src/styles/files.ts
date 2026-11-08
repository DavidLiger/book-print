// src/styles/files.ts — écritures de la bibliothèque de styles (IC2). Mêmes garanties que les autres fichiers de données : écriture sûre par
// `atomic.ts`, aucun lien suivi, rien hors de `dataRoot`. Un style existant n'est jamais écrasé par une création, et un style invalide n'est
// jamais réécrit : son erreur s'affiche, David le corrige dans le fichier (question 1).
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../data/atomic';
import { collectionFolder } from '../data/collection';
import {
  essaiFolder, essaiSchema, ESSAI_FILE, imageKind, PREVIEW_CACHE, previewFolder, previewName, readStyle, realDir, realFile,
  referenceFileFor, StyleRefused, stylesFolder, STYLES_DIR, type EssaiInput,
} from './read';
import { ESSAI_DIR, REFERENCE_FILES, STYLE_FILE, styleIdSchema, styleSchema, type Style } from './schema';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function requireCollection(dataRoot: string): string {
  const dir = collectionFolder(dataRoot);
  if (!dir) throw new StyleRefused('collection/ absent : le créer d\'abord dans la page.');
  return dir;
}

/** `collection/styles/`, créé au premier style. */
function ensureStylesFolder(dataRoot: string): string {
  const existing = stylesFolder(dataRoot);
  if (existing) return existing;
  const dir = path.join(requireCollection(dataRoot), STYLES_DIR);
  fs.mkdirSync(dir);
  return dir;
}

function checkedStyle(style: unknown): Style {
  const parsed = styleSchema.safeParse(style);
  if (!parsed.success) throw new StyleRefused(`Style refusé : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}.`);
  return parsed.data;
}

/** Nouveau style : dossier créé, `style.json` écrit sans écraser. Un dossier existant est refusé, même vide. */
export function createStyle(dataRoot: string, id: string, style: unknown): Style {
  if (!styleIdSchema.safeParse(id).success) throw new StyleRefused(`Identifiant de style refusé : ${id} (minuscules, chiffres et tirets, 40 caractères au plus).`);
  const checked = checkedStyle(style);
  const dir = path.join(ensureStylesFolder(dataRoot), id);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new StyleRefused(`Le style ${id} existe déjà : rien n'est écrasé.`);
  fs.mkdirSync(dir);
  const fd = fs.openSync(path.join(dir, STYLE_FILE), 'wx');
  try {
    fs.writeFileSync(fd, json(checked));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return checked;
}

/** Dossier d'un style valide : un style refusé n'est jamais réécrit. */
function validStyleFolder(dataRoot: string, id: string): string {
  const s = readStyle(dataRoot, id);
  if (s.state !== 'ok') throw new StyleRefused(`${s.message} Le corriger dans le fichier : l'outil ne le réécrit pas.`);
  return path.join(stylesFolder(dataRoot)!, id);
}

/** Modifie un style existant et valide. Le fichier de la référence reste celui du disque : la page ne le choisit pas. Rien à changer : aucune écriture. */
export function saveStyle(dataRoot: string, id: string, style: unknown): Style {
  const dir = validStyleFolder(dataRoot, id);
  const before = fs.readFileSync(path.join(dir, STYLE_FILE), 'utf8');
  const checked = checkedStyle(style);
  const next = json(checked);
  if (next !== before) writeAtomic(dir, STYLE_FILE, next);
  return checked;
}

/** La référence présente sur le disque, si le style en garde une. */
export function referenceOnDisk(dataRoot: string, id: string): (typeof REFERENCE_FILES)[number] | null {
  const dir = path.join(stylesFolder(dataRoot)!, id);
  for (const name of REFERENCE_FILES) if (realFile(path.join(dir, name), `collection/styles/${id}/${name}`)) return name;
  return null;
}

/**
 * Range la référence d'un style, telle quelle, octet pour octet (question 5) : la réencoder changerait les pixels lus par ComfyUI, et elle
 * n'entre jamais dans le PDF. L'autre format est retiré : un style garde une seule référence. `style.json` est réécrit ensuite.
 */
export function storeReference(dataRoot: string, id: string, bytes: Buffer): Style {
  const dir = validStyleFolder(dataRoot, id);
  const s = readStyle(dataRoot, id);
  if (s.state !== 'ok') throw new StyleRefused(s.message);
  if (s.style.reference.type === 'aucune') throw new StyleRefused(`Le style ${s.style.name} n'a pas de référence : choisir d'abord « dessin de David » ou « image externe ».`);
  const kind = imageKind(bytes);
  if (!kind) throw new StyleRefused('Référence refusée : PNG ou JPEG attendu.');
  const name = referenceFileFor(kind);
  writeAtomic(dir, name, bytes);
  for (const other of REFERENCE_FILES) if (other !== name && realFile(path.join(dir, other), `collection/styles/${id}/${other}`)) fs.rmSync(path.join(dir, other));
  return saveStyle(dataRoot, id, { ...s.style, reference: { ...s.style.reference, file: name } });
}

/** `collection/styles/_essai/`, créé au premier dépôt. */
function ensureEssaiFolder(dataRoot: string): string {
  const existing = essaiFolder(dataRoot);
  if (existing) return existing;
  const dir = path.join(ensureStylesFolder(dataRoot), ESSAI_DIR);
  fs.mkdirSync(dir);
  return dir;
}

/** Rendu ou Mist d'essai, gardé tel quel comme les entrées d'IC1 : la taille est contrôlée par l'appelant. */
export function storeEssaiInput(dataRoot: string, kind: EssaiInput, bytes: Buffer): void {
  writeAtomic(ensureEssaiFolder(dataRoot), `${kind}.png`, bytes);
}

export function saveEssaiPrompt(dataRoot: string, prompt: string): void {
  const dir = ensureEssaiFolder(dataRoot);
  const content = json(essaiSchema.parse({ schemaVersion: 1, prompt }));
  const file = path.join(dir, ESSAI_FILE);
  if (realFile(file, `collection/styles/${ESSAI_DIR}/${ESSAI_FILE}`) && fs.readFileSync(file, 'utf8') === content) return;
  writeAtomic(dir, ESSAI_FILE, content);
}

/** `collection/.cache/`, créé au besoin : hors git par `*\/.cache/`. Les dépôts y passent par un temporaire. */
export function cacheRoot(dataRoot: string): string {
  const root = fs.realpathSync.native(dataRoot);
  const dir = path.join(requireCollection(dataRoot), PREVIEW_CACHE[0]);
  if (!realDir(dir, `collection/${PREVIEW_CACHE[0]}/`, root)) fs.mkdirSync(dir);
  return dir;
}

/** Range un aperçu sous sa clé et retire les aperçus plus anciens du même style : un seul par style, celui de sa version en vigueur. */
export function writePreview(dataRoot: string, id: string, key: string, png: Buffer): void {
  let dir = previewFolder(dataRoot);
  if (!dir) {
    const root = fs.realpathSync.native(dataRoot);
    dir = requireCollection(dataRoot);
    let label = 'collection/';
    for (const segment of PREVIEW_CACHE) {
      dir = path.join(dir, segment);
      label += `${segment}/`;
      if (!realDir(dir, label, root)) fs.mkdirSync(dir);
    }
  }
  const name = previewName(id, key);
  writeAtomic(dir, name, png);
  for (const other of fs.readdirSync(dir)) {
    if (other !== name && other.startsWith(`${id}.`) && /^[a-z0-9-]+\.[0-9a-f]{16}\.png$/.test(other) && other.slice(0, other.indexOf('.')) === id) {
      if (fs.lstatSync(path.join(dir, other)).isFile()) fs.rmSync(path.join(dir, other));
    }
  }
}
