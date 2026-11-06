// src/server/essai-actions.ts — collection et essai du gabarit 2A. Aucune lecture de GLBInterpreter. Le `bookId` vient de la page et
// passe par les refus de `bookFolder` ; le nom du thème doit exister dans le style lu.
import { z } from 'zod';
import { CollectionRefused, createCollection, readCollection } from '../data/collection';
import { bookFolder } from '../data/pricing-file';
import { essaiFor, exportEssai } from '../render/essai';
import { RenderRefused } from '../render/html';
import { slugSchema } from '../schema/common';
import { GeometryRefused } from '../templates/geometry';

export class BadEssaiRequest extends Error {}

type Json = Record<string, unknown>;

/** Le HTML imprimé n'a aucun script ni aucune ressource externe : le cadre de la page ne peut rien charger de plus. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

const bookOnly = z.strictObject({ bookId: z.string() });
const exportBody = z.strictObject({ bookId: z.string(), theme: slugSchema });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadEssaiRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

/** Une erreur d'état se montre dans la page : c'est là que David corrige `style.json`, sans relancer l'outil. */
function state(dataRoot: string, bookId: string): Json {
  const folder = bookFolder(dataRoot, bookId) !== null;
  let collection;
  try {
    collection = readCollection(dataRoot);
  } catch (e) {
    if (e instanceof CollectionRefused) return { folder, collection: { exists: true, error: e.message }, themes: [], layout: null };
    throw e;
  }
  if (!collection) return { folder, collection: { exists: false, error: null }, themes: [], layout: null };
  const themes = Object.keys(collection.style.palette.themes);
  const base = { folder, collection: { exists: true, error: null }, themes, theme: collection.style.variants.rotation[0] };
  try {
    return { ...base, layout: essaiFor(dataRoot, bookId).layout };
  } catch (e) {
    if (e instanceof RenderRefused || e instanceof GeometryRefused) return { ...base, layout: null, error: e.message };
    throw e;
  }
}

let exporting = false;

export const ESSAI_ACTIONS: Record<string, (body: unknown, dataRoot: string) => Json | Promise<Json>> = {
  '/api/essai/state': (body, dataRoot) => state(dataRoot, parse(bookOnly, body).bookId),
  '/api/collection/create': (_body, dataRoot) => ({ result: createCollection(dataRoot) }),
  '/api/essai/export': async (body, dataRoot) => {
    const { bookId, theme } = parse(exportBody, body);
    if (exporting) throw new RenderRefused('Un export est déjà en cours.');
    exporting = true;
    try {
      return { ...(await exportEssai(dataRoot, bookId, theme)) };
    } finally {
      exporting = false;
    }
  },
};

export function previewHtml(bookId: string | null, theme: string | null, dataRoot: string): string {
  const { bookId: id, theme: name } = parse(exportBody, { bookId, theme });
  if (bookFolder(dataRoot, id) === null) throw new RenderRefused(`Dossier du livre absent : ${id}/.`);
  return essaiFor(dataRoot, id, name).html;
}
