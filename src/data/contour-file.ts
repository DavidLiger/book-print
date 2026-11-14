// src/data/contour-file.ts — `<bookId>/illustrations/<sujetId>/<element>.contour.json` (ED2, spec §24.6), hors git, à côté du PNG gardé.
// Il porte l'empreinte SHA-256 du PNG : un PNG remplacé à la main ou un dépôt interrompu entre les deux fichiers se voit, et l'étape
// Illustrations demande de redéposer. Écrit après le PNG, par écriture sûre. Le chemin vient du sujet et de l'élément, jamais du fichier.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { outlineIn, type Contour } from '../images/contour';
import { readPngHeader } from '../images/png';
import type { LayoutPage } from '../templates/geometry';
import { writeAtomic } from './atomic';
import { illustrationFile, illustrationFolder } from './illustration-file';

export const CONTOUR_VERSION = 1 as const;
export const contourName = (zone: string) => `${zone}.contour.json`;

const point = z.tuple([z.number().finite(), z.number().finite()]);
const partSchema = z.strictObject({ pixels: z.number().int().positive(), gauche: z.number().int().nonnegative(), haut: z.number().int().nonnegative(), droite: z.number().int().positive(), bas: z.number().int().positive() });
export const contourFileSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTOUR_VERSION),
    image: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }),
    seuil: z.number().int().min(1).max(255),
    points: z.array(point).min(3, 'contour : 3 points au moins'),
    empreinte: z.string().regex(/^[0-9a-f]{64}$/, 'empreinte : SHA-256 en hexadécimal'),
    autresParties: z.array(partSchema),
    /** Trous du détouré (ED5) ; absent d'un fichier d'ED2 : aucun trou. */
    trous: z.array(z.array(point).min(3, 'trou : 3 points au moins')).default([]),
  })
  .superRefine((c, ctx) => {
    if ([...c.points, ...c.trous.flat()].some(([x, y]) => x < 0 || y < 0 || x > c.image.width || y > c.image.height)) ctx.addIssue({ code: 'custom', path: ['points'], message: 'point hors de l\'image' });
  });
export type ContourFile = z.infer<typeof contourFileSchema>;

export const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

export function contourFile(contour: Contour, png: Buffer): ContourFile {
  return contourFileSchema.parse({
    schemaVersion: CONTOUR_VERSION,
    image: { width: contour.width, height: contour.height },
    seuil: contour.seuil,
    points: contour.points,
    empreinte: sha256(png),
    autresParties: contour.autresParties,
    ...(contour.trous.length > 0 ? { trous: contour.trous } : {}),
  });
}

/** Écrit après le PNG : son empreinte est celle du PNG gardé. */
export function writeContour(folder: string, zone: string, file: ContourFile): void {
  writeAtomic(folder, contourName(zone), `${JSON.stringify(file, null, 2)}\n`);
}

export type ContourReading = { state: 'ok'; contour: ContourFile } | { state: 'absent' } | { state: 'refuse'; message: string };

/** Le contour d'un détouré, contrôlé contre le PNG gardé (`png`, chemin réel déjà contrôlé par `illustrationFile`). */
export function readContour(folder: string, zone: string, png: string): ContourReading {
  const file = path.join(folder, contourName(zone));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { state: 'absent' };
  if (!stat.isFile()) return { state: 'refuse', message: `${contourName(zone)} n'est pas un fichier réel.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { state: 'refuse', message: `${contourName(zone)} illisible : redéposer l'image.` };
  }
  const result = contourFileSchema.safeParse(parsed);
  if (!result.success) return { state: 'refuse', message: `${contourName(zone)} invalide (${result.error.issues[0]!.message}) : redéposer l'image.` };
  const bytes = fs.readFileSync(png);
  if (sha256(bytes) !== result.data.empreinte) return { state: 'refuse', message: `${contourName(zone)} ne correspond plus à l'image : redéposer l'image.` };
  const header = readPngHeader(bytes);
  if (!header || header.width !== result.data.image.width || header.height !== result.data.image.height) return { state: 'refuse', message: `${contourName(zone)} : taille différente de l'image, redéposer l'image.` };
  return { state: 'ok', contour: result.data };
}

/** Le contour d'un détouré d'un sujet, s'il a son image : `null` sans image ; un refus nommé si le contour manque ou ne correspond plus. */
export function subjectContour(dataRoot: string, bookId: string, subjectId: string, zone: string): ContourReading | null {
  const file = illustrationFile(dataRoot, bookId, subjectId, zone);
  if (file.state !== 'ok') return null;
  const folder = illustrationFolder(dataRoot, bookId, subjectId)!;
  return readContour(folder, zone, file.path);
}

/**
 * Pose le contour de chaque détouré qui a son image et un contour valide (rendu, habillage, C17). Sans lui, le détouré reste sa boîte :
 * l'étape Illustrations dit pourquoi. Les pages sont copiées, jamais modifiées.
 */
export function withOutlines(pages: LayoutPage[], dataRoot: string, bookId: string, subjectId: string, illustrated: (zone: string) => boolean): LayoutPage[] {
  return pages.map((page) => ({
    ...page,
    zones: page.zones.map((zone) => {
      if (!zone.detoure || !illustrated(zone.id)) return zone;
      const read = subjectContour(dataRoot, bookId, subjectId, zone.id);
      return read?.state === 'ok' ? { ...zone, outline: outlineIn(zone.rect, { width: read.contour.image.width, height: read.contour.image.height, points: read.contour.points, trous: read.contour.trous }) } : zone;
    }),
  }));
}
