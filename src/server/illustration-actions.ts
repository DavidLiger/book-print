// src/server/illustration-actions.ts — illustrations d'un sujet (spec §5.2, étape 6) : dépôt, cadrage, rattachement des droits. Aucune sortie réseau.
// Changer une image ou son cadrage ne touche pas `relu`, qui porte sur le texte. `rights.json` est écrit avant `subject.json`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from '../data/atomic';
import { illustrationFile, illustrationFolder, illustrationName } from '../data/illustration-file';
import { SubjectRefused, updateSubject } from '../data/subject-file';
import { cleanPng, ImageRefused, MAX_UPLOAD_BYTES } from '../images/clean';
import { DEFAULT_FRAMING } from '../images/crop';
import { imageChecks, illustrationZones, subjectContext, type SubjectContext } from '../render/subject';
import { allEntries, ensureIllustrationRights, readBookRights, setIllustrationRights } from '../rights/registry';
import { slugSchema } from '../schema/common';
import { ILLUSTRATION_KINDS } from '../schema/rights';
import { framingSchema, illustrationFileName, type Illustration } from '../schema/subject';
import type { Config } from './config';
import { reading } from './subject-actions';

export class BadImageRequest extends Error {}
export class UploadTooLarge extends Error {}

export const DEPOSIT_ROUTE = '/api/sujet/illustration';

type Json = Record<string, unknown>;

const subjectBody = z.strictObject({ dir: z.string(), subjectId: slugSchema });
const framingBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, framing: framingSchema });
const rightsBody = z.strictObject({ dir: z.string(), subjectId: slugSchema, zone: slugSchema, rights: z.array(slugSchema) });
const zoneQuery = z.strictObject({ dir: z.string(), subject: slugSchema, zone: slugSchema, t: z.string().optional(), confirm: z.literal('1').optional() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadImageRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

function context(config: Config, dir: string, subjectId: string): SubjectContext {
  const read = reading(config, dir);
  return subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes);
}

function requireZone(ctx: SubjectContext, zone: string): void {
  if (!illustrationZones(ctx).some((z) => z.id === zone)) throw new SubjectRefused(`Le gabarit ${ctx.template.id} n'a pas de zone d'illustration ${zone}.`);
}

function view(config: Config, dir: string, subjectId: string): Json {
  const ctx = context(config, dir, subjectId);
  const { zones, checks } = imageChecks(ctx);
  const registry = allEntries(ctx.collection.rights, readBookRights(config.dataRoot, ctx.book.bookId));
  return {
    zones,
    checks,
    // Seules les entrées du registre sont proposées : aucune saisie libre ici.
    entries: [...registry.values()].filter((e) => ILLUSTRATION_KINDS.includes(e.kind)).map(({ id, kind, name, author, license, commercialOk }) => ({ id, kind, name, author, license, commercialOk })),
  };
}

/** Le corps va en flux dans le temporaire : la limite joue sans le garder en mémoire. `destroyOnReturn` : la réponse 413 doit encore pouvoir partir. */
async function receive(req: http.IncomingMessage, file: string): Promise<void> {
  const fd = fs.openSync(file, 'wx');
  try {
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`Fichier trop gros : ${MAX_UPLOAD_BYTES / (1024 * 1024)} Mio au plus.`);
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writePng(folder: string, zone: string, png: Buffer): void {
  try {
    writeAtomic(folder, illustrationName(zone), png);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new ImageRefused(`${illustrationName(zone)} est ouvert dans un autre programme : le fermer, puis redéposer.`);
    throw e;
  }
}

let depositing = false;

/** Second dépôt sur une zone : `needsConfirm`, rien d'écrit. L'ancien fichier n'est pas gardé : l'original reste dans le dossier de ComfyUI. */
export async function depositIllustration(query: URLSearchParams, req: http.IncomingMessage, config: Config): Promise<Json> {
  const { dir, subject, zone, confirm } = parse(zoneQuery, Object.fromEntries(query));
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`Fichier trop gros : ${MAX_UPLOAD_BYTES / (1024 * 1024)} Mio au plus.`);
  if (depositing) throw new ImageRefused('Un dépôt est déjà en cours.');
  depositing = true;
  let tmp: string | null = null;
  try {
    const ctx = context(config, dir, subject);
    requireZone(ctx, zone);
    const bookId = ctx.book.bookId;
    const folder = illustrationFolder(config.dataRoot, bookId, subject, true);
    if (!folder) throw new SubjectRefused(`Dossier du livre absent : ${bookId}/.`);
    const target = fs.lstatSync(path.join(folder, illustrationName(zone)), { throwIfNoEntry: false });
    if (target && !target.isFile()) throw new SubjectRefused(`${illustrationName(zone)} n'est pas un fichier réel : rien n'est écrit.`);
    // Un registre illisible se voit avant d'écrire l'image, pas après.
    readBookRights(config.dataRoot, bookId);
    tmp = path.join(folder, `${zone}.${crypto.randomBytes(6).toString('hex')}.depot.tmp`);
    await receive(req, tmp);
    // Le nettoyage d'abord : un fichier refusé l'est tout de suite, sans passer par la confirmation.
    const { png, width, height } = await cleanPng(fs.readFileSync(tmp));
    if ((target || ctx.subject.illustrations.some((i) => i.zone === zone)) && !confirm) return { needsConfirm: true };
    writePng(folder, zone, png);
    ensureIllustrationRights(config.dataRoot, bookId, subject, zone);
    const entry: Illustration = { zone, file: illustrationFileName(subject, zone), width, height, framing: DEFAULT_FRAMING };
    updateSubject(config.dataRoot, bookId, subject, (data) => ({ ...data, subject: { ...data.subject, illustrations: [...data.subject.illustrations.filter((i) => i.zone !== zone), entry] } }));
    return { deposited: true, width, height, ...view(config, dir, subject) };
  } finally {
    depositing = false;
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

export function illustrationBytes(query: URLSearchParams, config: Config): Buffer {
  const { dir, subject, zone } = parse(zoneQuery, Object.fromEntries(query));
  const ctx = context(config, dir, subject);
  requireZone(ctx, zone);
  const file = illustrationFile(config.dataRoot, ctx.book.bookId, subject, zone);
  if (file.state !== 'ok') throw new SubjectRefused(file.state === 'refuse' ? file.message : `Aucune image dans la zone ${zone}.`);
  return fs.readFileSync(file.path);
}

function changeFraming(config: Config, value: z.infer<typeof framingBody>): Json {
  const { dir, subjectId, zone, framing } = value;
  const ctx = context(config, dir, subjectId);
  if (!ctx.subject.illustrations.some((i) => i.zone === zone)) throw new SubjectRefused(`Aucune image dans la zone ${zone} : la déposer d'abord.`);
  updateSubject(config.dataRoot, ctx.book.bookId, subjectId, (data) => ({
    ...data,
    subject: { ...data.subject, illustrations: data.subject.illustrations.map((i) => (i.zone === zone ? { ...i, framing } : i)) },
  }));
  return view(config, dir, subjectId);
}

function changeRights(config: Config, value: z.infer<typeof rightsBody>): Json {
  const { dir, subjectId, zone, rights } = value;
  const ctx = context(config, dir, subjectId);
  requireZone(ctx, zone);
  const bookId = ctx.book.bookId;
  const registry = allEntries(ctx.collection.rights, readBookRights(config.dataRoot, bookId));
  for (const id of rights) {
    const entry = registry.get(id);
    if (!entry) throw new SubjectRefused(`Droit inconnu du registre : ${id}.`);
    if (!ILLUSTRATION_KINDS.includes(entry.kind)) throw new SubjectRefused(`${id} ne se rattache pas à une illustration.`);
  }
  setIllustrationRights(config.dataRoot, bookId, subjectId, zone, [...new Set(rights)]);
  return view(config, dir, subjectId);
}

export const ILLUSTRATION_ACTIONS: Record<string, (body: unknown, config: Config) => Json> = {
  '/api/sujet/images': (body, config) => {
    const { dir, subjectId } = parse(subjectBody, body);
    return view(config, dir, subjectId);
  },
  '/api/sujet/cadrage': (body, config) => changeFraming(config, parse(framingBody, body)),
  '/api/sujet/droits-image': (body, config) => changeRights(config, parse(rightsBody, body)),
};
