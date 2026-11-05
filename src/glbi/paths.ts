// src/glbi/paths.ts — garde-fous de chemins (spec §3.6, MP-7). Pur, sauf `fs.realpathSync.native` (remplaçable par les tests).
import fs from 'node:fs';
import path from 'node:path';

/** Tout chemin qui cite le dossier d'essai est refusé, sans casse (Windows : `QR-Essai` = `qr-essai`). */
const TRIAL_QR = /qr-essai/i;

export type Realpath = (p: string) => string;
export const nativeRealpath: Realpath = (p) => fs.realpathSync.native(p);

export class PathRefused extends Error {}
export class PathMissing extends Error {}

/** `child` (chemin réel) est `root` ou se trouve dessous. Comparaison exacte : les deux viennent de `realpath`. */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * Chemin réel de `rel` sous `root`, ou exception.
 * - `rel` : relatif, séparateur `/`, sans `.` ni `..`, sans `qr-essai` ;
 * - le chemin réel reste sous la racine réelle (un lien ne fait pas sortir) ;
 * - sa casse réelle est celle de `rel` : Windows ouvrirait `Out/book.json`, le livre publié, lui, y est sensible.
 */
export function resolveUnder(root: string, rel: string, realpath: Realpath = nativeRealpath): string {
  if (TRIAL_QR.test(rel)) throw new PathRefused(`chemin refusé (QR d'essai) : ${rel}`);
  const segments = rel.split('/');
  if (rel.includes('\\') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new PathRefused(`chemin refusé (hors de la racine) : ${rel}`);
  }
  const rootReal = realpath(root);
  let real: string;
  try {
    real = realpath(path.join(rootReal, ...segments));
  } catch {
    throw new PathMissing(`fichier absent : ${rel}`);
  }
  if (!isInside(rootReal, real)) throw new PathRefused(`chemin refusé (hors de la racine) : ${rel}`);
  const relReal = toPosix(path.relative(rootReal, real));
  if (TRIAL_QR.test(relReal)) throw new PathRefused(`chemin refusé (QR d'essai) : ${rel}`);
  if (relReal !== rel) throw new PathRefused(`chemin refusé : ${rel} ne correspond pas au chemin réel ${relReal}`);
  return real;
}
