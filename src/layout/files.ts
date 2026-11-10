// src/layout/files.ts — la copie d'une mise en page modèle dans un sujet (ED1, MP-24) : `subjects/<sujetId>/layout.json`. Un modèle de la
// version 1 y est converti ; un modèle de la version 2 y est recopié. `modele` garde son origine : identifiant, empreinte des octets du
// fichier modèle lu, date. Un modèle modifié ensuite ne touche plus le sujet. La lecture et l'écriture du fichier passent par
// `data/subject-file.ts`, avec les refus de chemin des sujets.
//
// ED3 (spec §24.3, §24.8) : écriture sûre par l'éditeur, d'un modèle de `collection/gabarits/` ou du `layout.json` d'un sujet. Le fichier
// n'est réécrit que s'il est encore celui que l'éditeur a lu (empreinte SHA-256 des octets lus ; `null` : le fichier n'existait pas) ; un lien
// est refusé, sans rien lire ni écrire. Au premier enregistrement d'un modèle de la version 1, ce fichier est gardé tel quel dans
// `collection/gabarits/archives/<id>.<date>.json`, jamais lu comme modèle, avant d'être remplacé par sa conversion.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../data/atomic';
import type { Margins, Trim } from '../templates/geometry';
import { fromV1 } from './from-v1';
import { isLayout, type MiseEnPage } from './model';
import { subjectLayoutSchema, type Layout, type SubjectLayout } from './schema';

export const LAYOUT_FILE = 'layout.json';

/** La copie d'un modèle pour un sujet qui commence en `firstPage`. Le format et le côté sont contrôlés avant, par la création du sujet. */
export function copyModel(model: MiseEnPage, sha256: string, trim: Trim, margins: Margins, firstPage: number, now: Date): SubjectLayout {
  const layout: Layout = isLayout(model) ? model : fromV1(model, trim, margins, firstPage);
  return subjectLayoutSchema.parse({ ...structuredClone(layout), modele: { id: model.id, empreinte: sha256, date: now.toISOString() } });
}

/** La mise en page d'un `layout.json`, sans son origine. */
export function layoutOf(file: SubjectLayout): Layout {
  const { modele: _modele, ...layout } = file;
  return layout;
}

/** Une mise en page refusée par l'éditeur : schéma, style, format ou nombre de pages. Rien n'est écrit. */
export class LayoutRefused extends Error {}
/** Le fichier a changé depuis sa lecture par l'éditeur (ou un lien est à sa place) : rien n'est écrit, la page le relit. */
export class LayoutConflict extends Error {}

export const ARCHIVES_DIR = 'archives';
export const layoutJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Octets d'un fichier réel, `null` s'il n'existe pas. Un lien, une jonction ou un dossier à sa place est refusé. */
export function readLayoutBytes(file: string, label: string): Buffer | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new LayoutConflict(`${label} n'est pas un fichier réel : rien n'est lu ni écrit.`);
  return fs.readFileSync(file);
}

function realDir(dir: string, label: string): void {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new LayoutConflict(`${label} n'est pas un dossier réel : rien n'est écrit.`);
}

/**
 * Écriture sûre (fichier temporaire, `fsync`, renommage) de `dir/name`, seulement si le fichier est encore celui qui a été lu : même
 * empreinte, ou toujours absent pour `expected: null`. Rend l'empreinte des octets écrits.
 */
export function writeIfUnchanged(dir: string, name: string, content: string, expected: string | null, label: string): string {
  realDir(dir, path.dirname(label) + '/');
  const current = readLayoutBytes(path.join(dir, name), label);
  const same = expected === null ? current === null : current !== null && sha256(current) === expected;
  if (!same) throw new LayoutConflict(`${label} a changé depuis sa lecture : il est relu, l'historique d'annulation repart de zéro.`);
  writeAtomic(dir, name, content);
  return sha256(Buffer.from(content, 'utf8'));
}

/** `2026-11-10T15-04-05-123Z` : une date sans deux-points, valable dans un nom de fichier sous Windows. */
export const fileStamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-');

/**
 * La version 1 d'un modèle, gardée telle quelle avant son premier enregistrement par l'éditeur : `archives/<id>.<date>.json`, à côté des
 * modèles. Le dossier est créé s'il manque ; un lien à sa place est refusé ; rien n'est écrasé (`wx`). Rend le chemin, depuis `collection/`.
 */
export function archiveV1(templatesDir: string, id: string, bytes: Buffer, now: Date): string {
  const dir = path.join(templatesDir, ARCHIVES_DIR);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) fs.mkdirSync(dir);
  else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LayoutConflict(`collection/gabarits/${ARCHIVES_DIR}/ n'est pas un dossier réel : rien n'est écrit.`);
  const name = `${id}.${fileStamp(now)}.json`;
  fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
  return `gabarits/${ARCHIVES_DIR}/${name}`;
}
