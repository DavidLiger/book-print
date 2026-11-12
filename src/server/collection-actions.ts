// src/server/collection-actions.ts — état et création de `collection/`. L'étape Essai a disparu en ED6 : il ne reste que la collection.
// Aucune lecture de GLBInterpreter. Le `bookId` vient de la page et passe par les refus de `bookFolder`.
import { z } from 'zod';
import { CollectionRefused, createCollection, readCollection } from '../data/collection';
import { bookFolder } from '../data/pricing-file';

export class BadCollectionRequest extends Error {}

type Json = Record<string, unknown>;

/** Le HTML imprimé n'a aucun script ni aucune ressource externe : le cadre de la page ne peut rien charger de plus. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

const bookOnly = z.strictObject({ bookId: z.string() });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const body = schema.safeParse(value);
  if (!body.success) throw new BadCollectionRequest(body.error.issues.map((i) => `${i.path.join('.') || 'corps'} : ${i.message}`).join(' ; '));
  return body.data;
}

/** Une erreur d'état se montre dans la page : c'est là que David corrige `style.json`, sans relancer l'outil. */
function state(dataRoot: string, bookId: string): Json {
  const folder = bookFolder(dataRoot, bookId) !== null;
  let collection;
  try {
    collection = readCollection(dataRoot);
  } catch (e) {
    if (e instanceof CollectionRefused) return { folder, collection: { exists: true, error: e.message }, themes: [] };
    throw e;
  }
  if (!collection) return { folder, collection: { exists: false, error: null }, themes: [] };
  return { folder, collection: { exists: true, error: null }, themes: Object.keys(collection.style.palette.themes), theme: collection.style.variants.rotation[0] };
}

export const COLLECTION_ACTIONS: Record<string, (body: unknown, dataRoot: string) => Json> = {
  '/api/collection/state': (body, dataRoot) => state(dataRoot, parse(bookOnly, body).bookId),
  '/api/collection/create': (_body, dataRoot) => ({ result: createCollection(dataRoot) }),
};
