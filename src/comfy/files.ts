// src/comfy/files.ts — fichiers de la génération dans le dossier de données (IC1, questions 4 et 7). Tous hors git.
//   illustrations/<sujetId>/<zone>.rendu.png, <zone>.mist.png : les entrées déposées par David, gardées telles quelles, sans nettoyage ;
//   .cache/ic1/<sujetId>/<zone>/ : les trois images générées (g<graine>.png), corrigées (c<graine>.png), et candidats.json. Supprimable.
// Mêmes refus que les autres fichiers : aucun lien, rien hors de dataRoot. Les noms viennent toujours du sujet, de la zone et de la graine.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from '../data/atomic';
import { illustrationFolder } from '../data/illustration-file';
import { bookFolder } from '../data/pricing-file';
import { SubjectRefused } from '../data/subject-file';
import { isInside } from '../glbi/paths';
import { readPngHeaderOfFile, type PngHeader } from '../images/png';
import { slugSchema } from '../schema/common';

export const INPUT_KINDS = ['rendu', 'mist'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export const INPUT_LABELS: Record<InputKind, string> = { rendu: 'rendu', mist: 'passe Mist' };
export const inputName = (zone: string, kind: InputKind) => `${zone}.${kind}.png`;

export type InputFile = { state: 'ok'; path: string; header: PngHeader } | { state: 'absent' } | { state: 'refuse'; message: string };

export function inputFile(dataRoot: string, bookId: string, subjectId: string, zone: string, kind: InputKind): InputFile {
  const dir = illustrationFolder(dataRoot, bookId, subjectId);
  if (!dir) return { state: 'absent' };
  const file = path.join(dir, inputName(zone, kind));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { state: 'absent' };
  if (!stat.isFile()) return { state: 'refuse', message: `${inputName(zone, kind)} n'est pas un fichier réel.` };
  const header = readPngHeaderOfFile(file);
  if (!header) return { state: 'refuse', message: `${inputName(zone, kind)} n'est pas un PNG : le redéposer.` };
  return { state: 'ok', path: file, header };
}

function realDir(dir: string, label: string, root: string, create: boolean): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) {
    if (!create) return false;
    fs.mkdirSync(dir);
    return true;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SubjectRefused(`${label} n'est pas un dossier réel : rien n'est lu ni écrit.`);
  if (!isInside(root, fs.realpathSync.native(dir))) throw new SubjectRefused(`${label} sort de dataRoot : rien n'est lu ni écrit.`);
  return true;
}

/** `<bookId>/.cache/ic1/<sujetId>/<zone>/`, créé segment par segment. `null` : absent, sans `create`. */
export function cacheFolder(dataRoot: string, bookId: string, subjectId: string, zone: string, create = false): string | null {
  for (const id of [subjectId, zone]) if (!slugSchema.safeParse(id).success) throw new SubjectRefused(`Identifiant refusé : ${id}.`);
  const book = bookFolder(dataRoot, bookId);
  if (!book) return null;
  const root = fs.realpathSync.native(dataRoot);
  let dir = book;
  let label = `${bookId}/`;
  for (const segment of ['.cache', 'ic1', subjectId, zone]) {
    dir = path.join(dir, segment);
    label += `${segment}/`;
    if (!realDir(dir, label, root, create)) return null;
  }
  return dir;
}

export const CANDIDATES_FILE = 'candidats.json';
export const generatedName = (seed: number) => `g${seed}.png`;
export const correctedName = (seed: number) => `c${seed}.png`;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const fieldsSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()])));

/** Ce qu'il faut pour agrandir un candidat et tracer l'image finale. */
export const candidatesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  date: z.iso.datetime(),
  comfyuiVersion: z.string(),
  prompt: z.string(),
  dosage: z.number(),
  workflow: z.strictObject({ file: z.string(), date: z.iso.datetime(), sha256: sha }),
  /** Le style de la génération, tel qu'il était (IC2) : l'agrandissement reprend ses prompts et ses droits, même si le style change ensuite. */
  style: z.strictObject({
    id: z.string(),
    sha256: sha,
    upscale: z.strictObject({ prompt: z.string(), negative: z.string() }),
    /** Droit de la référence du style, `null` sans référence. */
    rights: z.string().nullable(),
  }),
  inputs: z.strictObject({ rendu: sha, mist: sha, reference: z.strictObject({ name: z.string(), sha256: sha }).nullable() }),
  size: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
  /** `seconds` : génération et correction ; `correctionSeconds` : la correction seule, faite par l'outil. */
  candidates: z.array(z.strictObject({ seed: z.number().int().nonnegative(), generated: sha, corrected: sha, fields: fieldsSchema, seconds: z.number(), correctionSeconds: z.number() })),
});
export type Candidates = z.infer<typeof candidatesSchema>;

export function readCandidates(dataRoot: string, bookId: string, subjectId: string, zone: string): Candidates | null {
  const dir = cacheFolder(dataRoot, bookId, subjectId, zone);
  if (!dir) return null;
  const file = path.join(dir, CANDIDATES_FILE);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    const parsed = candidatesSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Une image du cache, par sa graine : `null` si absente. */
export function cacheImage(dataRoot: string, bookId: string, subjectId: string, zone: string, name: string): Buffer | null {
  if (!/^[gc]\d+\.png$/.test(name)) throw new SubjectRefused(`Fichier refusé : ${name}.`);
  const dir = cacheFolder(dataRoot, bookId, subjectId, zone);
  if (!dir) return null;
  const file = path.join(dir, name);
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file) : null;
}

/** Vide le cache d'une zone : un nouveau « Générer » ou une nouvelle entrée remplace les candidats. Le dossier est vérifié avant. */
export function clearCandidates(dataRoot: string, bookId: string, subjectId: string, zone: string): void {
  const dir = cacheFolder(dataRoot, bookId, subjectId, zone);
  if (!dir) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isFile()) fs.rmSync(file);
  }
}

export const writeCacheFile = (dir: string, name: string, content: string | Buffer) => writeAtomic(dir, name, content);
