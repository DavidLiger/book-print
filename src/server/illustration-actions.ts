// src/server/illustration-actions.ts — illustrations d'un sujet (spec §5.2, étape 6) : dépôt, cadrage, rattachement des droits. Aucune sortie réseau.
// Changer une image ou son cadrage ne touche pas `relu`, qui porte sur le texte. `rights.json` est écrit avant `subject.json`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { illustrationFile, illustrationName } from '../data/illustration-file';
import { prepareIllustration, storeIllustration } from '../data/illustration-store';
import { SubjectRefused, updateSubject } from '../data/subject-file';
import { cleanDetoure, cleanPng, ImageRefused, MAX_UPLOAD_BYTES } from '../images/clean';
import { imageChecks, illustrationZones, subjectContext, type SubjectContext } from '../render/subject';
import { allEntries, readBookRights, setIllustrationRights } from '../rights/registry';
import { slugSchema } from '../schema/common';
import { ILLUSTRATION_KINDS } from '../schema/rights';
import { framingSchema } from '../schema/subject';
import type { Config } from './config';
import { qrSourceOf, reading } from './subject-actions';

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

export function context(config: Config, dir: string, subjectId: string): SubjectContext {
  const read = reading(config, dir);
  return subjectContext(config.dataRoot, read.bookId, subjectId, read.scenes, qrSourceOf(config, read));
}

export function requireZone(ctx: SubjectContext, zone: string): void {
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
export async function receive(req: http.IncomingMessage, file: string): Promise<void> {
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
    const folder = prepareIllustration(config.dataRoot, bookId, subject, zone);
    tmp = path.join(folder, `${zone}.${crypto.randomBytes(6).toString('hex')}.depot.tmp`);
    await receive(req, tmp);
    // Le nettoyage d'abord : un fichier refusé l'est tout de suite, sans passer par la confirmation. Un détouré exige l'alpha et en tire
    // son contour (ED2) ; une illustration rectangulaire garde le nettoyage de MP4, alpha aplati sur blanc.
    const detoure = illustrationZones(ctx).find((z) => z.id === zone)?.detoure === true;
    const bytes = fs.readFileSync(tmp);
    const cleaned = detoure ? await cleanDetoure(bytes) : { image: await cleanPng(bytes), contour: undefined };
    const exists = fs.lstatSync(path.join(folder, illustrationName(zone)), { throwIfNoEntry: false });
    if ((exists || ctx.subject.illustrations.some((i) => i.zone === zone)) && !confirm) return { needsConfirm: true };
    // Un dépôt manuel n'a pas de traçabilité : `generation` disparaît, les droits restent.
    const { width, height } = storeIllustration(config.dataRoot, bookId, subject, zone, cleaned.image, cleaned.contour ? { contour: cleaned.contour } : {});
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
  const generated = ctx.subject.illustrations.some((i) => i.zone === zone && i.generation !== undefined);
  const hasAiModel = rights.some((id) => registry.get(id)?.kind === 'modele-ia');
  setIllustrationRights(config.dataRoot, bookId, subjectId, zone, [...new Set(rights)], generated || hasAiModel);
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
