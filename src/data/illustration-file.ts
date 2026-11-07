// src/data/illustration-file.ts — `<bookId>/illustrations/<sujetId>/<zone>.png`, hors git. Seule la version nettoyée est gardée : l'original reste
// dans le dossier de ComfyUI. Tout lien ou jonction est refusé. Le chemin vient toujours du sujet et de la zone, jamais de `subject.json`.
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../glbi/paths';
import { COLOR_RGB, readPngHeaderOfFile, type PngHeader } from '../images/png';
import { slugSchema } from '../schema/common';
import { bookFolder } from './pricing-file';
import { SubjectRefused } from './subject-file';

function realDir(dir: string, label: string, root: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SubjectRefused(`${label} n'est pas un dossier réel : rien n'est lu ni écrit.`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new SubjectRefused(`${label} sort de dataRoot : rien n'est lu ni écrit.`);
  return true;
}

/** Dossier réel des illustrations d'un sujet. `create` : il est créé au premier dépôt ; sinon `null` s'il n'existe pas. */
export function illustrationFolder(dataRoot: string, bookId: string, subjectId: string, create = false): string | null {
  if (!slugSchema.safeParse(subjectId).success) throw new SubjectRefused(`Sujet refusé : ${subjectId}.`);
  const book = bookFolder(dataRoot, bookId);
  if (!book) return null;
  const root = fs.realpathSync.native(dataRoot);
  const parent = path.join(book, 'illustrations');
  const dir = path.join(parent, subjectId);
  for (const [folder, label] of [[parent, `${bookId}/illustrations/`], [dir, `${bookId}/illustrations/${subjectId}/`]] as const) {
    if (realDir(folder, label, root)) continue;
    if (!create) return null;
    fs.mkdirSync(folder);
  }
  return dir;
}

export const illustrationName = (zone: string) => `${zone}.png`;

export type IllustrationFile = { state: 'ok'; path: string; header: PngHeader } | { state: 'absent' } | { state: 'refuse'; message: string };

/** Le fichier a pu être remplacé à la main : ses dimensions réelles font foi, et tout ce qui n'est pas du RVB 8 bits repasse par le dépôt. */
export function illustrationFile(dataRoot: string, bookId: string, subjectId: string, zone: string): IllustrationFile {
  const dir = illustrationFolder(dataRoot, bookId, subjectId);
  if (!dir) return { state: 'absent' };
  const file = path.join(dir, illustrationName(zone));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { state: 'absent' };
  if (!stat.isFile()) return { state: 'refuse', message: `${illustrationName(zone)} n'est pas un fichier réel.` };
  const header = readPngHeaderOfFile(file);
  if (!header) return { state: 'refuse', message: `${illustrationName(zone)} n'est pas un PNG : le redéposer.` };
  if (header.bitDepth !== 8 || header.colorType !== COLOR_RGB) return { state: 'refuse', message: `${illustrationName(zone)} n'est pas en RVB 8 bits : le redéposer.` };
  return { state: 'ok', path: file, header };
}
