// src/data/illustration-store.ts — rangement d'une image nettoyée dans sa zone : le chemin du dépôt de MP4, partagé avec l'agrandissement d'IC1.
// L'ordre ne change pas : le PNG, puis `rights.json`, puis `subject.json`. Le cadrage repart de zéro. Un dépôt manuel n'a pas de `generation` :
// il l'efface. Les droits déjà rattachés restent, sauf si l'appelant en donne la liste.
import fs from 'node:fs';
import path from 'node:path';
import { cleanPng, ImageRefused, type CleanedPng } from '../images/clean';
import type { Contour } from '../images/contour';
import { DEFAULT_FRAMING } from '../images/crop';
import { ensureIllustrationRights, readBookRights, setIllustrationRights } from '../rights/registry';
import { illustrationFileName, type Generation, type Illustration } from '../schema/subject';
import { writeAtomic } from './atomic';
import { contourFile, contourName, writeContour } from './contour-file';
import { illustrationFolder, illustrationName } from './illustration-file';
import { SubjectRefused, updateSubject } from './subject-file';

export function writeIllustrationPng(folder: string, zone: string, png: Buffer): void {
  try {
    writeAtomic(folder, illustrationName(zone), png);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new ImageRefused(`${illustrationName(zone)} est ouvert dans un autre programme : le fermer, puis redéposer.`);
    throw e;
  }
}

/** Dossier de la zone prêt à écrire : créé au besoin, l'image en place n'est pas un lien, le registre est lisible. Rien n'est écrit d'autre. */
export function prepareIllustration(dataRoot: string, bookId: string, subjectId: string, zone: string): string {
  const folder = illustrationFolder(dataRoot, bookId, subjectId, true);
  if (!folder) throw new SubjectRefused(`Dossier du livre absent : ${bookId}/.`);
  const target = fs.lstatSync(path.join(folder, illustrationName(zone)), { throwIfNoEntry: false });
  if (target && !target.isFile()) throw new SubjectRefused(`${illustrationName(zone)} n'est pas un fichier réel : rien n'est écrit.`);
  // Un registre illisible se voit avant d'écrire l'image, pas après.
  readBookRights(dataRoot, bookId);
  return folder;
}

export interface StoreOptions {
  /** Traçabilité d'une image produite par l'outil. Absente : dépôt manuel. */
  generation?: Generation;
  /** Droits à rattacher à la place de ceux de la zone. */
  rights?: string[];
  /** Contour d'un détouré (ED2) : écrit juste après le PNG, avec son empreinte. */
  contour?: Contour;
}

export function storeIllustration(dataRoot: string, bookId: string, subjectId: string, zone: string, image: CleanedPng, options: StoreOptions = {}): Illustration {
  const folder = prepareIllustration(dataRoot, bookId, subjectId, zone);
  writeIllustrationPng(folder, zone, image.png);
  if (options.contour) {
    try {
      writeContour(folder, zone, contourFile(options.contour, image.png));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new ImageRefused(`${contourName(zone)} est ouvert dans un autre programme : le fermer, puis redéposer.`);
      throw e;
    }
  }
  ensureIllustrationRights(dataRoot, bookId, subjectId, zone);
  if (options.rights) setIllustrationRights(dataRoot, bookId, subjectId, zone, options.rights);
  const entry: Illustration = { zone, file: illustrationFileName(subjectId, zone), width: image.width, height: image.height, framing: DEFAULT_FRAMING, ...(options.generation ? { generation: options.generation } : {}) };
  updateSubject(dataRoot, bookId, subjectId, (data) => ({ ...data, subject: { ...data.subject, illustrations: [...data.subject.illustrations.filter((i) => i.zone !== zone), entry] } }));
  return entry;
}

export { cleanPng };
