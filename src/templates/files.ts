// src/templates/files.ts — gabarits en fichiers (GB1, spec §3.4). Un gabarit est `collection/gabarits/<id>.json`, validé par `templateSchema`,
// relu à chaque action comme `style.json` : David le crée, le modifie ou le retire à la main, sans patch ni redémarrage. Un gabarit invalide
// est refusé seul, avec son erreur, et n'est jamais réécrit. Les gabarits livrés viennent de `src/templates/defaults/gabarits/` et ne sont
// copiés que là où le fichier manque.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { collectionFolder, CollectionRefused } from '../data/collection';
import { ensureDir, writeNew, type WriteReport } from '../data/create-book';
import type { Style } from '../schema/style';
import { templatePages } from '../schema/common';
import { elementsOf, isLayout, type MiseEnPage } from '../layout/model';
import { layoutSchema } from '../layout/schema';
import { templateSchema, type Template } from './model';

export const TEMPLATES_DIR = 'gabarits';
const DELIVERED = fileURLToPath(new URL('./defaults/gabarits/', import.meta.url));
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

export interface TemplateEntry {
  /** Le nom du fichier sans `.json` : l'identifiant attendu. */
  id: string;
  file: string;
  /** Version 1 (GB1) ou version 2 (ED1). */
  template: MiseEnPage | null;
  /** `null` : gabarit valide. */
  error: string | null;
  /** SHA-256 des octets lus : l'empreinte notée dans la copie d'un sujet (ED1, `modele`). `null` pour un fichier qui n'est pas lu. */
  sha256: string | null;
}

export interface TemplateLibrary {
  /** `collection/gabarits/` existe. */
  present: boolean;
  /** Dossier refusé : rien n'est lu. */
  error: string | null;
  entries: TemplateEntry[];
}

/** Ce que le style doit connaître : la couleur d'un encadré, un pictogramme. Vérifié à la lecture, le style étant relu lui aussi. */
export function templateStyleFaults(template: MiseEnPage, style: Pick<Style, 'palette' | 'pictos'>): string[] {
  const faults: string[] = [];
  for (const zone of elementsOf(template)) {
    if (zone.encadre !== undefined && !Object.hasOwn(style.palette.boxes, zone.encadre)) faults.push(`${zone.id} : couleur d'encadré inconnue de palette.boxes, ${zone.encadre}`);
    if (zone.picto !== undefined && !Object.hasOwn(style.pictos, zone.picto)) faults.push(`${zone.id} : pictogramme inconnu de style.pictos, ${zone.picto}`);
    if (zone.icone !== undefined && !Object.hasOwn(style.pictos, zone.icone)) faults.push(`${zone.id} : icône inconnue de style.pictos, ${zone.icone}`);
  }
  return faults;
}

/**
 * Fichier lu, validé, comparé à son nom. `style` absent : seul le schéma est vérifié (gabarits livrés). Un fichier qui porte `schemaVersion`
 * est une mise en page version 2 (ED1) ; sans lui, un gabarit de GB1, lu par le chemin de GB1.
 */
export function parseTemplate(text: string, id: string, style: Pick<Style, 'palette' | 'pictos'> | null): { template: MiseEnPage | null; error: string | null } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { template: null, error: `JSON invalide : ${(e as Error).message}` };
  }
  const v2 = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'schemaVersion');
  const parsed = v2 ? layoutSchema.safeParse(value) : templateSchema.safeParse(value);
  if (!parsed.success) return { template: null, error: issues(parsed.error) };
  // Casse comprise : Windows ne distingue pas `2a.json` de `2A.json`, un sujet qui cite `2A` doit trouver exactement ce fichier.
  if (parsed.data.id !== id) return { template: null, error: `id ${parsed.data.id} : le fichier doit s'appeler ${parsed.data.id}.json` };
  const faults = style ? templateStyleFaults(parsed.data, style) : [];
  if (faults.length > 0) return { template: null, error: faults.join(' ; ') };
  return { template: parsed.data, error: null };
}

/** Ordre de lecture : par nombre de pages, puis par lettre. */
const byPages = (a: string, b: string) => templatePages(a) - templatePages(b) || a.localeCompare(b);

/** Dossier réel des gabarits, `null` s'il n'existe pas. Un lien ou un fichier à sa place est refusé. */
function templatesFolder(dataRoot: string): string | null {
  const collection = collectionFolder(dataRoot);
  if (!collection) return null;
  const dir = path.join(collection, TEMPLATES_DIR);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CollectionRefused(`collection/${TEMPLATES_DIR}/ n'est pas un dossier réel : rien n'est lu ni écrit`);
  return dir;
}

/** Tous les gabarits de la collection, valides ou non. Rien n'est écrit. Un fichier autre que `.json` est ignoré. */
export function readTemplates(dataRoot: string, style: Pick<Style, 'palette' | 'pictos'> | null): TemplateLibrary {
  let dir: string | null;
  try {
    dir = templatesFolder(dataRoot);
  } catch (e) {
    if (e instanceof CollectionRefused) return { present: true, error: e.message, entries: [] };
    throw e;
  }
  if (!dir) return { present: false, error: null, entries: [] };
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  const entries = names
    .map((name): TemplateEntry => {
      const id = name.slice(0, -'.json'.length);
      const file = `collection/${TEMPLATES_DIR}/${name}`;
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile()) return { id, file, template: null, error: 'n\'est pas un fichier réel', sha256: null };
      const bytes = fs.readFileSync(path.join(dir, name));
      return { id, file, ...parseTemplate(bytes.toString('utf8'), id, style), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    })
    .sort((a, b) => byPages(a.id, b.id));
  return { present: true, error: null, entries };
}

/** Gabarits valides, par identifiant. */
export function validTemplates(library: TemplateLibrary): Record<string, MiseEnPage> {
  return Object.fromEntries(library.entries.flatMap((e) => (e.template ? [[e.id, e.template]] : [])));
}

/** Le gabarit `id` de la collection, ou ce qui l'empêche : absent ou invalide, nommé. */
export function templateOf(library: TemplateLibrary, id: string): { template: MiseEnPage; sha256: string } | { error: string } {
  if (library.error) return { error: library.error };
  const entry = library.entries.find((e) => e.id === id);
  if (!entry) return { error: `Gabarit ${id} absent de collection/${TEMPLATES_DIR}/.` };
  if (!entry.template) return { error: `Gabarit ${id} invalide : ${entry.error}` };
  return { template: entry.template, sha256: entry.sha256! };
}

/** Noms des gabarits livrés avec l'outil. */
export const deliveredNames = () => fs.readdirSync(DELIVERED).filter((n) => n.endsWith('.json')).sort((a, b) => byPages(a.slice(0, -5), b.slice(0, -5)));

/** Un gabarit livré, validé par le schéma : un fichier livré invalide est une faute du code. */
export function deliveredTemplate(id: string): Template {
  const { template, error } = parseTemplate(fs.readFileSync(path.join(DELIVERED, `${id}.json`), 'utf8'), id, null);
  if (!template || isLayout(template)) throw new Error(`Gabarit livré ${id} invalide : ${error ?? 'version 1 attendue'}`);
  return template;
}

/**
 * « Ajouter les gabarits livrés » et la création de la collection : n'écrit que les fichiers absents. Un fichier présent, même invalide
 * ou modifié par David, est conservé tel quel ; un lien à la place d'un fichier aussi (`wx` ne le suit pas).
 */
export function addDeliveredTemplates(dataRoot: string, out: WriteReport = { created: [], kept: [] }): WriteReport {
  if (!collectionFolder(dataRoot)) throw new CollectionRefused('collection/ absent : le créer d\'abord dans la page.');
  const root = fs.realpathSync.native(dataRoot);
  ensureDir(root, ['collection', TEMPLATES_DIR], out);
  for (const name of deliveredNames()) writeNew(root, `collection/${TEMPLATES_DIR}/${name}`, fs.readFileSync(path.join(DELIVERED, name), 'utf8'), out);
  return out;
}
