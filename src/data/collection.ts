// src/data/collection.ts — `collection/` du dossier de données (spec §3.1, architecture §4). Le repo public n'en contient pas et un
// patch n'écrit pas dans les données : l'action de la page copie les valeurs par défaut versionnées, sans jamais écraser un fichier.
// David règle ensuite thèmes, pictogrammes et fiche dans ces fichiers : tout est relu à chaque aperçu, sans relancer l'outil.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isInside } from '../glbi/paths';
import { rightsFileSchema, type RightsFile } from '../schema/rights';
import { styleSchema, type Style } from '../schema/style';
import { ensureDir, writeNew, type WriteReport } from './create-book';

const DEFAULTS = fileURLToPath(new URL('../templates/defaults/', import.meta.url));
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

export class CollectionRefused extends Error {}

export interface Collection {
  style: Style;
  rights: RightsFile;
  /** SVG des pictogrammes, par nom du style. */
  pictos: Record<string, string>;
}

/** `collection/` réel sous `dataRoot`, `null` s'il n'existe pas encore. Mêmes refus que le dossier d'un livre. */
export function collectionFolder(dataRoot: string): string | null {
  const root = fs.realpathSync.native(dataRoot);
  const dir = path.join(root, 'collection');
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CollectionRefused('collection/ n\'est pas un dossier réel : rien n\'est lu ni écrit');
  if (!isInside(root, fs.realpathSync.native(dir))) throw new CollectionRefused('collection/ sort de dataRoot : rien n\'est lu ni écrit');
  return dir;
}

export function createCollection(dataRoot: string): WriteReport {
  const root = fs.realpathSync.native(dataRoot);
  const out: WriteReport = { created: [], kept: [] };
  ensureDir(root, ['collection', 'pictos'], out);
  collectionFolder(dataRoot);
  const copy = (name: string) => writeNew(root, `collection/${name}`, fs.readFileSync(path.join(DEFAULTS, ...name.split('/')), 'utf8'), out);
  copy('style.json');
  copy('rights.json');
  for (const file of fs.readdirSync(path.join(DEFAULTS, 'pictos')).sort()) copy(`pictos/${file}`);
  // Gabarits livrés (GB1) : copiés comme le style, sans écraser.
  ensureDir(root, ['collection', 'gabarits'], out);
  for (const file of fs.readdirSync(path.join(DEFAULTS, 'gabarits')).filter((n) => n.endsWith('.json')).sort()) copy(`gabarits/${file}`);
  return out;
}

/** Un SVG va tel quel dans le HTML imprimé : il ne doit rien charger ni rien exécuter, et sa taille vient de son `viewBox`. */
export function svgFault(svg: string): string | null {
  if (!/^\s*<svg[\s>]/.test(svg)) return 'le fichier doit commencer par <svg';
  if (!/\bviewBox=/.test(svg)) return 'viewBox manquant';
  if (/<(script|image|foreignObject|style|use)\b/i.test(svg)) return 'élément interdit (script, image, foreignObject, style ou use)';
  if (/\son[a-z]+\s*=/i.test(svg) || /\bhref\s*=/i.test(svg)) return 'attribut interdit (on… ou href)';
  return null;
}

function readJson<T>(dir: string, name: string, schema: z.ZodType<T>): T {
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new CollectionRefused(`collection/${name} absent : relancer « Créer la collection » dans la page, rien n'est écrasé.`);
  if (!stat.isFile()) throw new CollectionRefused(`collection/${name} n'est pas un fichier réel.`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new CollectionRefused(`collection/${name} n'est pas un JSON valide : ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CollectionRefused(`collection/${name} invalide : ${issues(parsed.error)}`);
  return parsed.data;
}

/** `null` : `collection/` n'existe pas encore. Une collection invalide n'est jamais corrigée ni remplacée : le message dit quoi reprendre. */
export function readCollection(dataRoot: string): Collection | null {
  const dir = collectionFolder(dataRoot);
  if (!dir) return null;
  const style = readJson(dir, 'style.json', styleSchema);
  const rights = readJson(dir, 'rights.json', rightsFileSchema);
  const known = new Set(rights.entries.map((e) => e.id));
  const pictos: Record<string, string> = {};
  for (const [name, picto] of Object.entries(style.pictos)) {
    if (!known.has(picto.rights)) throw new CollectionRefused(`Pictogramme ${name} : droits ${picto.rights} absents de collection/rights.json.`);
    const file = path.join(dir, 'pictos', picto.file);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new CollectionRefused(`Pictogramme ${name} : collection/pictos/${picto.file} absent.`);
    const svg = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const fault = svgFault(svg);
    if (fault) throw new CollectionRefused(`Pictogramme ${name} : ${fault}.`);
    pictos[name] = svg;
  }
  return { style, rights, pictos };
}
